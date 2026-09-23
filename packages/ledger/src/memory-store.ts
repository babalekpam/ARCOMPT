// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { LedgerError } from "./errors.js";
import { Money, sum } from "./money.js";
import type { AuditEvent, LedgerStore } from "./store.js";
import type {
  Account,
  AccountBalance,
  AccountClass,
  Actor,
  FiscalYear,
  ForeignPosition,
  Id,
  Journal,
  JournalEntry,
  JournalType,
  Period,
} from "./types.js";

export const DEFAULT_JOURNALS: Array<{ code: string; label: string; type: JournalType }> = [
  { code: "AC", label: "Achats", type: "ACHATS" },
  { code: "VT", label: "Ventes", type: "VENTES" },
  { code: "BQ", label: "Banque", type: "BANQUE" },
  { code: "CA", label: "Caisse", type: "CAISSE" },
  { code: "PA", label: "Paie", type: "PAIE" },
  { code: "OD", label: "Opérations diverses", type: "OD" },
  { code: "AN", label: "À-nouveaux", type: "AN" },
];

export interface MemoryAccountSeed {
  number: string;
  label: string;
  lettrable?: boolean;
  postable?: boolean;
}

/** Adaptateur en mémoire : tests, simulations, mode hors ligne. */
export class MemoryStore implements LedgerStore {
  private accounts = new Map<string, Account>(); // key tenant|number
  private journals = new Map<string, Journal>(); // key tenant|code
  private fiscalYears = new Map<string, FiscalYear>(); // key id
  private periods = new Map<string, Period>(); // key id
  private entries = new Map<string, JournalEntry>(); // key id
  private clientIds = new Map<string, string>(); // tenant|clientId -> entryId
  readonly audit: AuditEvent[] = [];

  seedAccounts(tenantId: Id, seeds: MemoryAccountSeed[]): void {
    for (const s of seeds) {
      const cls = Number(s.number[0]) as AccountClass;
      this.accounts.set(`${tenantId}|${s.number}`, {
        id: randomUUID(),
        tenantId,
        number: s.number,
        label: s.label,
        class: cls,
        nature: natureOf(cls),
        lettrable: s.lettrable ?? /^(40|41|42)/.test(s.number),
        postable: s.postable ?? true,
        active: true,
      });
    }
  }

  seedJournals(tenantId: Id, journals = DEFAULT_JOURNALS): void {
    for (const j of journals) {
      this.journals.set(`${tenantId}|${j.code}`, { id: randomUUID(), tenantId, ...j });
    }
  }

  async createFiscalYear(tenantId: Id, fy: Omit<FiscalYear, "id" | "tenantId" | "status">): Promise<FiscalYear> {
    const year: FiscalYear = { id: randomUUID(), tenantId, status: "OPEN", ...fy };
    this.fiscalYears.set(year.id, year);
    for (const [start, end] of monthlyRanges(fy.startDate, fy.endDate)) {
      const p: Period = { id: randomUUID(), tenantId, fiscalYearId: year.id, startDate: start, endDate: end, status: "OPEN" };
      this.periods.set(p.id, p);
    }
    return year;
  }

  async getAccountByNumber(tenantId: Id, number: string): Promise<Account | null> {
    return this.accounts.get(`${tenantId}|${number}`) ?? null;
  }

  async listAccounts(tenantId: Id): Promise<Account[]> {
    return [...this.accounts.values()].filter((a) => a.tenantId === tenantId).sort((a, b) => a.number.localeCompare(b.number));
  }

  async getJournalByCode(tenantId: Id, code: string): Promise<Journal | null> {
    return this.journals.get(`${tenantId}|${code}`) ?? null;
  }

  async listJournals(tenantId: Id): Promise<Journal[]> {
    return [...this.journals.values()].filter((j) => j.tenantId === tenantId);
  }

  async findPeriodForDate(tenantId: Id, date: string) {
    for (const p of this.periods.values()) {
      if (p.tenantId === tenantId && p.startDate <= date && date <= p.endDate) {
        const fy = this.fiscalYears.get(p.fiscalYearId);
        if (!fy) return null;
        return { period: p, fiscalYear: fy };
      }
    }
    return null;
  }

  async listFiscalYears(tenantId: Id): Promise<FiscalYear[]> {
    return [...this.fiscalYears.values()].filter((f) => f.tenantId === tenantId).sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  async getFiscalYearByCode(tenantId: Id, code: string): Promise<FiscalYear | null> {
    return [...this.fiscalYears.values()].find((f) => f.tenantId === tenantId && f.code === code) ?? null;
  }

  async getEntry(tenantId: Id, entryId: Id): Promise<JournalEntry | null> {
    const e = this.entries.get(entryId);
    return e && e.tenantId === tenantId ? clone(e) : null;
  }

  async findEntryByClientId(tenantId: Id, clientId: Id): Promise<JournalEntry | null> {
    const id = this.clientIds.get(`${tenantId}|${clientId}`);
    return id ? this.getEntry(tenantId, id) : null;
  }

  async insertDraft(entry: JournalEntry, clientId?: Id): Promise<JournalEntry> {
    this.entries.set(entry.id, clone(entry));
    if (clientId) this.clientIds.set(`${entry.tenantId}|${clientId}`, entry.id);
    return clone(entry);
  }

  async deleteDraft(tenantId: Id, entryId: Id): Promise<void> {
    const e = this.entries.get(entryId);
    if (!e || e.tenantId !== tenantId) throw new LedgerError("ENTRY_NOT_FOUND", `Écriture ${entryId} introuvable`);
    if (e.status !== "DRAFT") throw new LedgerError("ENTRY_IMMUTABLE", "Une écriture validée ne se supprime pas ; contrepassez-la");
    this.entries.delete(entryId);
  }

  async lastValidated(tenantId: Id, journalId: Id) {
    let best: JournalEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.tenantId === tenantId && e.journalId === journalId && e.status === "VALIDATED") {
        if (!best || (e.number ?? 0) > (best.number ?? 0)) best = e;
      }
    }
    return best && best.number !== null && best.hash ? { number: best.number, hash: best.hash } : null;
  }

  async markValidated(entry: JournalEntry, fields: { number: number; prevHash: string | null; hash: string; validatedBy: Id; validatedAt: string }) {
    const stored = this.entries.get(entry.id);
    if (!stored || stored.tenantId !== entry.tenantId) throw new LedgerError("ENTRY_NOT_FOUND", `Écriture ${entry.id} introuvable`);
    if (stored.status !== "DRAFT") throw new LedgerError("ENTRY_IMMUTABLE", "Écriture déjà validée");
    const period = this.periods.get(stored.periodId);
    if (!period || period.status !== "OPEN") throw new LedgerError("PERIOD_LOCKED", "Période clôturée ou verrouillée");
    const updated: JournalEntry = { ...stored, status: "VALIDATED", ...fields };
    this.entries.set(entry.id, updated);
    return clone(updated);
  }

  async linkReversal(tenantId: Id, originalId: Id, reversalId: Id): Promise<void> {
    const o = this.entries.get(originalId);
    if (!o || o.tenantId !== tenantId) throw new LedgerError("ENTRY_NOT_FOUND", `Écriture ${originalId} introuvable`);
    this.entries.set(originalId, { ...o, reversedByEntryId: reversalId });
  }

  async accountBalances(tenantId: Id, from: string, to: string): Promise<AccountBalance[]> {
    const acc = new Map<string, { debit: Money[]; credit: Money[] }>();
    for (const e of this.entries.values()) {
      if (e.tenantId !== tenantId || e.status !== "VALIDATED" || e.date < from || e.date > to) continue;
      for (const l of e.lines) {
        const cur = acc.get(l.accountNumber) ?? { debit: [], credit: [] };
        // Montants convertis : la balance est tenue dans la devise du dossier.
        cur.debit.push(l.debitBase);
        cur.credit.push(l.creditBase);
        acc.set(l.accountNumber, cur);
      }
    }
    const rows: AccountBalance[] = [];
    for (const [number, v] of acc) {
      const a = this.accounts.get(`${tenantId}|${number}`);
      rows.push({
        accountNumber: number,
        label: a?.label ?? "",
        class: (a?.class ?? Number(number[0])) as AccountClass,
        debit: sum(v.debit),
        credit: sum(v.credit),
      });
    }
    return rows.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  }

  async foreignPositions(tenantId: Id, from: string, to: string, opts: { accountPrefixes?: string[] } = {}): Promise<ForeignPosition[]> {
    const agg = new Map<string, ForeignPosition>();
    for (const e of this.entries.values()) {
      if (e.tenantId !== tenantId || e.status !== "VALIDATED" || e.date < from || e.date > to) continue;
      for (const l of e.lines) {
        if (l.rate === null) continue; // ligne déjà dans la devise du dossier
        if (opts.accountPrefixes && !opts.accountPrefixes.some((p) => l.accountNumber.startsWith(p))) continue;
        const key = `${l.accountNumber}|${l.partnerId ?? ""}|${l.currency}`;
        const a = this.accounts.get(`${tenantId}|${l.accountNumber}`);
        const cur =
          agg.get(key) ??
          ({
            accountNumber: l.accountNumber,
            accountLabel: a?.label ?? "",
            class: (a?.class ?? Number(l.accountNumber[0])) as AccountClass,
            partnerId: l.partnerId,
            currency: l.currency,
            foreignDebit: Money.zero(),
            foreignCredit: Money.zero(),
            baseDebit: Money.zero(),
            baseCredit: Money.zero(),
          } satisfies ForeignPosition);
        agg.set(key, {
          ...cur,
          foreignDebit: cur.foreignDebit.add(l.debit),
          foreignCredit: cur.foreignCredit.add(l.credit),
          baseDebit: cur.baseDebit.add(l.debitBase),
          baseCredit: cur.baseCredit.add(l.creditBase),
        });
      }
    }
    return [...agg.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber) || a.currency.localeCompare(b.currency) || (a.partnerId ?? "").localeCompare(b.partnerId ?? ""));
  }

  async listValidatedEntries(tenantId: Id, journalId: Id): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.tenantId === tenantId && e.journalId === journalId && e.status === "VALIDATED")
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map(clone);
  }

  async listEntries(tenantId: Id, opts: { fiscalYearCode: string; accountNumber?: string }): Promise<JournalEntry[]> {
    const fy = await this.getFiscalYearByCode(tenantId, opts.fiscalYearCode);
    if (!fy) return [];
    const prefix = opts.accountNumber;
    return [...this.entries.values()]
      .filter((e) => e.tenantId === tenantId && e.fiscalYearId === fy.id && e.status === "VALIDATED")
      .filter((e) => !prefix || e.lines.some((l) => l.accountNumber.startsWith(prefix)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.journalCode.localeCompare(b.journalCode) || (a.number ?? 0) - (b.number ?? 0))
      .map(clone);
  }

  async setPeriodStatus(tenantId: Id, periodId: Id, status: Period["status"], _actor: Actor): Promise<void> {
    const p = this.periods.get(periodId);
    if (!p || p.tenantId !== tenantId) throw new LedgerError("NO_OPEN_PERIOD", "Période introuvable");
    this.periods.set(periodId, { ...p, status });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }

  /** Accès direct pour les tests uniquement : simule une altération en base. */
  _unsafeTamper(entryId: Id, mutate: (e: JournalEntry) => void): void {
    const e = this.entries.get(entryId);
    if (e) mutate(e);
  }
}

export function natureOf(cls: AccountClass): Account["nature"] {
  switch (cls) {
    case 1:
      return "PASSIF";
    case 2:
    case 3:
      return "ACTIF";
    case 4:
      return "MIXTE";
    case 5:
      return "ACTIF";
    case 6:
      return "CHARGE";
    case 7:
      return "PRODUIT";
    case 8:
      return "MIXTE";
    case 9:
      return "ENGAGEMENT";
  }
}

export function monthlyRanges(start: string, end: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cursor = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (cursor <= last) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const monthEnd = new Date(Date.UTC(y, m + 1, 0));
    const rangeEnd = monthEnd > last ? last : monthEnd;
    out.push([iso(cursor), iso(rangeEnd)]);
    cursor = new Date(Date.UTC(y, m + 1, 1));
  }
  return out;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function clone(e: JournalEntry): JournalEntry {
  return { ...e, lines: e.lines.map((l) => ({ ...l })) };
}
