import { EntryValidationError, type ValidationIssue } from "./errors.js";
import { Money } from "./money.js";
import type { LedgerStore } from "./store.js";
import type { Account, Id, JournalEntryInput, JournalLineInput } from "./types.js";

export interface NormalizedLine {
  lineNo: number;
  account: Account;
  partnerId: Id | null;
  label: string;
  debit: Money;
  credit: Money;
  currency: string;
  rate: string | null;
  analyticCode: string | null;
  vatCode: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valide une écriture avant insertion. Les mêmes invariants existent en base
 * (triggers) : la validation applicative sert à produire des messages
 * utilisables et à travailler hors ligne.
 */
export async function normalizeAndValidate(
  store: LedgerStore,
  tenantId: Id,
  input: JournalEntryInput,
  baseCurrency: string,
): Promise<{ lines: NormalizedLine[]; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const lines: NormalizedLine[] = [];

  if (!ISO_DATE.test(input.date) || Number.isNaN(Date.parse(input.date))) {
    issues.push({ code: "INVALID_DATE", message: `Date invalide : ${input.date}` });
  }
  if (!input.lines || input.lines.length < 2) {
    issues.push({ code: "EMPTY_ENTRY", message: "Une écriture comporte au moins deux lignes" });
  }

  let lineNo = 0;
  for (const raw of input.lines ?? []) {
    lineNo += 1;
    const n = await normalizeLine(store, tenantId, raw, lineNo, baseCurrency, issues);
    if (n) lines.push(n);
  }

  const totalDebit = lines.reduce((acc, l) => acc.add(l.debit), Money.zero());
  const totalCredit = lines.reduce((acc, l) => acc.add(l.credit), Money.zero());
  if (!totalDebit.eq(totalCredit)) {
    issues.push({
      code: "UNBALANCED",
      message: `Écriture déséquilibrée : débits ${totalDebit} ≠ crédits ${totalCredit}`,
    });
  }
  if (lines.length > 0 && totalDebit.isZero() && totalCredit.isZero()) {
    issues.push({ code: "EMPTY_ENTRY", message: "Écriture sans montant" });
  }
  return { lines, issues };
}

async function normalizeLine(
  store: LedgerStore,
  tenantId: Id,
  raw: JournalLineInput,
  lineNo: number,
  baseCurrency: string,
  issues: ValidationIssue[],
): Promise<NormalizedLine | null> {
  let debit = Money.zero();
  let credit = Money.zero();
  try {
    if (raw.debit !== undefined) debit = Money.parse(raw.debit);
    if (raw.credit !== undefined) credit = Money.parse(raw.credit);
  } catch (e) {
    issues.push({ code: "LINE_NO_AMOUNT", message: `Ligne ${lineNo} : ${(e as Error).message}`, lineNo });
    return null;
  }
  if (!debit.isZero() && !credit.isZero()) {
    issues.push({ code: "LINE_BOTH_SIDES", message: `Ligne ${lineNo} : débit ou crédit, jamais les deux`, lineNo });
  }
  if (debit.isZero() && credit.isZero()) {
    issues.push({ code: "LINE_NO_AMOUNT", message: `Ligne ${lineNo} : montant nul`, lineNo });
  }
  if (debit.isNegative() || credit.isNegative()) {
    issues.push({ code: "LINE_NEGATIVE", message: `Ligne ${lineNo} : montant négatif ; inversez le sens`, lineNo });
  }
  const account = await store.getAccountByNumber(tenantId, raw.accountNumber);
  if (!account) {
    issues.push({ code: "UNKNOWN_ACCOUNT", message: `Ligne ${lineNo} : compte ${raw.accountNumber} absent du plan`, lineNo });
    return null;
  }
  if (!account.postable) {
    issues.push({ code: "ACCOUNT_NOT_POSTABLE", message: `Ligne ${lineNo} : compte ${account.number} non imputable (compte de regroupement)`, lineNo });
  }
  if (!account.active) {
    issues.push({ code: "ACCOUNT_INACTIVE", message: `Ligne ${lineNo} : compte ${account.number} désactivé`, lineNo });
  }
  if (account.lettrable && !raw.partnerId) {
    issues.push({ code: "PARTNER_REQUIRED", message: `Ligne ${lineNo} : le compte ${account.number} exige un tiers`, lineNo });
  }
  return {
    lineNo,
    account,
    partnerId: raw.partnerId ?? null,
    label: raw.label ?? "",
    debit,
    credit,
    currency: raw.currency ?? baseCurrency,
    rate: raw.rate ?? null,
    analyticCode: raw.analyticCode ?? null,
    vatCode: raw.vatCode ?? null,
  };
}

export function assertNoIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new EntryValidationError(issues);
}
