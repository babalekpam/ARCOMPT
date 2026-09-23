// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money } from "@arcompt/ledger";
import type { Sql } from "postgres";

/**
 * Détection d'anomalies : règles + écarts statistiques. Renvoie des alertes,
 * jamais de correction automatique.
 */
export type AnomalyCode = "NEGATIVE_CASH" | "VAT_INCONSISTENT" | "DUPLICATE_INVOICE" | "UNUSUAL_AMOUNT";

export interface Anomaly {
  code: AnomalyCode;
  severity: "WARNING" | "ERROR";
  message: string;
  entryIds: string[];
  accountNumber?: string;
  date?: string;
  amount?: string;
}

export interface AnomalyPeriod {
  from: string;
  to: string;
}

interface LineRow {
  entry_id: string;
  entry_date: string;
  journal_code: string;
  account: string;
  partner_id: string | null;
  partner_name: string | null;
  debit: string;
  credit: string;
}

const VAT_MAX_RATE = "0.2"; // au-delà de 20 %, la TVA est incohérente quel que soit le pays OHADA

export async function detectAnomalies(tx: Sql, tenantId: string, period: AnomalyPeriod): Promise<Anomaly[]> {
  const rows = (await tx`
    SELECT e.id AS entry_id, e.entry_date::text AS entry_date, j.code AS journal_code, a.number AS account, l.partner_id, p.name AS partner_name,
           l.debit::text AS debit, l.credit::text AS credit
      FROM journal_line l
      JOIN journal_entry e ON e.id = l.entry_id
      JOIN journal j ON j.id = e.journal_id
      JOIN account a ON a.id = l.account_id
      LEFT JOIN partner p ON p.id = l.partner_id
     WHERE l.tenant_id = ${tenantId} AND e.status = 'VALIDATED' AND e.entry_date <= ${period.to}
     ORDER BY e.entry_date, e.number, l.line_no`) as unknown as LineRow[];
  const inPeriod = rows.filter((r) => r.entry_date >= period.from);
  return [...negativeCash(rows, period), ...inconsistentVat(inPeriod), ...duplicateInvoices(inPeriod), ...unusualAmounts(inPeriod)];
}

/** Caisse négative : solde cumulé d'un compte 57x sous zéro à une date de la période. */
function negativeCash(rows: LineRow[], period: AnomalyPeriod): Anomaly[] {
  const out: Anomaly[] = [];
  const byAccount = new Map<string, LineRow[]>();
  for (const r of rows) if (r.account.startsWith("57")) byAccount.set(r.account, [...(byAccount.get(r.account) ?? []), r]);
  for (const [account, lines] of byAccount) {
    let balance = Money.zero();
    let reported = false;
    for (const l of lines) {
      balance = balance.add(Money.parse(l.debit)).sub(Money.parse(l.credit));
      if (balance.isNegative() && l.entry_date >= period.from && !reported) {
        out.push({ code: "NEGATIVE_CASH", severity: "ERROR", message: `Caisse ${account} négative (${balance}) au ${l.entry_date}`, entryIds: [l.entry_id], accountNumber: account, date: l.entry_date, amount: balance.toString() });
        reported = true;
      }
    }
  }
  return out;
}

/** TVA incohérente : TVA (443/445) supérieure à 20 % de la base (6xx/7xx) ou TVA sans base. */
function inconsistentVat(rows: LineRow[]): Anomaly[] {
  const out: Anomaly[] = [];
  const byEntry = groupBy(rows, (r) => r.entry_id);
  for (const [entryId, lines] of byEntry) {
    const vat = sumLines(lines.filter((l) => l.account.startsWith("443") || l.account.startsWith("445")));
    if (vat.isZero()) continue;
    const base = sumLines(lines.filter((l) => /^[67]/.test(l.account)));
    if (base.isZero() || vat.cmp(base.mulRate(VAT_MAX_RATE)) > 0) {
      out.push({ code: "VAT_INCONSISTENT", severity: "WARNING", message: `TVA ${vat} incohérente avec la base ${base} (écriture du ${lines[0]!.entry_date})`, entryIds: [entryId], date: lines[0]!.entry_date, amount: vat.toString() });
    }
  }
  return out;
}

/** Doublons de factures : même fournisseur (401) ou client (411), même montant, même date, écritures distinctes. */
function duplicateInvoices(rows: LineRow[]): Anomaly[] {
  const out: Anomaly[] = [];
  const seen = new Map<string, LineRow[]>();
  for (const r of rows) {
    if (!r.partner_id || !(r.account.startsWith("401") || r.account.startsWith("411"))) continue;
    const amount = Money.parse(r.debit).sub(Money.parse(r.credit)).abs();
    if (amount.isZero()) continue;
    const key = `${r.account.slice(0, 3)}|${r.partner_id}|${amount}|${r.entry_date}`;
    seen.set(key, [...(seen.get(key) ?? []), r]);
  }
  for (const lines of seen.values()) {
    const ids = [...new Set(lines.map((l) => l.entry_id))];
    if (ids.length < 2) continue;
    const l = lines[0]!;
    const amount = Money.parse(l.debit).sub(Money.parse(l.credit)).abs();
    out.push({ code: "DUPLICATE_INVOICE", severity: "WARNING", message: `${ids.length} écritures ${l.partner_name ?? l.partner_id} de ${amount} au ${l.entry_date} : doublon probable`, entryIds: ids, date: l.entry_date, amount: amount.toString() });
  }
  return out;
}

/** Montant inhabituel : plus de 5 × la médiane des mouvements du compte (au moins 5 mouvements). */
function unusualAmounts(rows: LineRow[]): Anomaly[] {
  const out: Anomaly[] = [];
  const byAccount = groupBy(rows, (r) => r.account);
  for (const [account, lines] of byAccount) {
    if (lines.length < 5) continue;
    const amounts = lines.map((l) => Money.parse(l.debit).add(Money.parse(l.credit))).sort((a, b) => a.cmp(b));
    const median = amounts[Math.floor(amounts.length / 2)]!;
    if (median.isZero()) continue;
    const threshold = median.mulRate("5");
    for (const l of lines) {
      const amount = Money.parse(l.debit).add(Money.parse(l.credit));
      if (amount.cmp(threshold) > 0) {
        out.push({ code: "UNUSUAL_AMOUNT", severity: "WARNING", message: `Montant ${amount} inhabituel sur ${account} (médiane ${median}) le ${l.entry_date}`, entryIds: [l.entry_id], accountNumber: account, date: l.entry_date, amount: amount.toString() });
      }
    }
  }
  return out;
}

function sumLines(lines: LineRow[]): Money {
  let total = Money.zero();
  for (const l of lines) total = total.add(Money.parse(l.debit)).add(Money.parse(l.credit));
  return total;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}
