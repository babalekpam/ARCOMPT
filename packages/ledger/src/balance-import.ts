import { LedgerError } from "./errors.js";
import type { Ledger } from "./ledger.js";
import { Money, sum } from "./money.js";
import type { Actor, JournalEntry, JournalEntryInput } from "./types.js";

/**
 * Import d'une balance (Excel, Sage 100, Perfecto…) sous forme de lignes
 * normalisées, avec table de correspondance des comptes, vers une écriture
 * d'à-nouveaux équilibrée dans le journal AN.
 */
export interface ImportedBalanceRow {
  account: string; // numéro dans le système source
  label?: string;
  debit: string | number; // solde débiteur
  credit: string | number; // solde créditeur
  partnerId?: string;
}

export interface BalanceImportOptions {
  /** Correspondance compte source → compte SYSCOHADA du dossier. Identité par défaut. */
  mapping?: Record<string, string>;
  /** Date de l'écriture d'à-nouveaux (premier jour de l'exercice en général). */
  date: string;
  label?: string;
  /** Tolérance d'arrondi acceptée (ex. "1" pour 1 FCFA) ; l'écart est imputé sur `roundingAccount`. */
  tolerance?: string;
  roundingAccount?: string;
  /** Les comptes de gestion (6, 7, 8) sont exclus des à-nouveaux : on ne reprend que le bilan. */
  balanceSheetOnly?: boolean;
}

export interface BalanceImportPlan {
  input: JournalEntryInput;
  skipped: Array<{ account: string; reason: string }>;
  totalDebit: Money;
  totalCredit: Money;
  difference: Money;
}

export function planBalanceImport(rows: ImportedBalanceRow[], opts: BalanceImportOptions): BalanceImportPlan {
  const mapping = opts.mapping ?? {};
  const skipped: BalanceImportPlan["skipped"] = [];
  const lines: JournalEntryInput["lines"] = [];
  const unmapped: string[] = [];

  for (const row of rows) {
    const target = mapping[row.account] ?? row.account;
    if (opts.balanceSheetOnly !== false && /^[678]/.test(target)) {
      skipped.push({ account: row.account, reason: "compte de gestion exclu des à-nouveaux" });
      continue;
    }
    const debit = Money.parse(row.debit ?? 0);
    const credit = Money.parse(row.credit ?? 0);
    const net = debit.sub(credit);
    if (net.isZero()) {
      skipped.push({ account: row.account, reason: "solde nul" });
      continue;
    }
    if (!/^\d{2,}$/.test(target)) {
      unmapped.push(row.account);
      continue;
    }
    lines.push({
      accountNumber: target,
      ...(net.isPositive() ? { debit: net } : { credit: net.neg() }),
      label: row.label ?? `À-nouveau ${target}`,
      ...(row.partnerId ? { partnerId: row.partnerId } : {}),
    });
  }
  if (unmapped.length > 0) {
    throw new LedgerError("IMPORT_UNMAPPED_ACCOUNT", `Comptes sans correspondance : ${unmapped.join(", ")}`, { unmapped });
  }

  const totalDebit = sum(lines.map((l) => Money.parse(l.debit ?? 0)));
  const totalCredit = sum(lines.map((l) => Money.parse(l.credit ?? 0)));
  const difference = totalDebit.sub(totalCredit);
  if (!difference.isZero()) {
    const tolerance = Money.parse(opts.tolerance ?? "0");
    if (difference.abs().cmp(tolerance) > 0 || !opts.roundingAccount) {
      throw new LedgerError("IMPORT_UNBALANCED", `Balance déséquilibrée : écart ${difference}`, { difference: difference.toString() });
    }
    lines.push({
      accountNumber: opts.roundingAccount,
      ...(difference.isPositive() ? { credit: difference } : { debit: difference.neg() }),
      label: "Écart d'arrondi à l'import",
    });
  }

  return {
    input: {
      journalCode: "AN",
      date: opts.date,
      label: opts.label ?? "Reprise des à-nouveaux",
      source: "IMPORT",
      lines,
    },
    skipped,
    totalDebit,
    totalCredit,
    difference,
  };
}

export async function importBalance(ledger: Ledger, actor: Actor, rows: ImportedBalanceRow[], opts: BalanceImportOptions): Promise<{ entry: JournalEntry; plan: BalanceImportPlan }> {
  const plan = planBalanceImport(rows, opts);
  const entry = await ledger.post(actor, plan.input);
  return { entry, plan };
}
