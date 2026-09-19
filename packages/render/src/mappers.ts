import { Money, type JournalEntry, type TrialBalance } from "@arcompt/ledger";
import type { LedgerAccountView, LedgerLineView, LedgerView, TrialBalanceView } from "./views.js";

/** Balance du moteur comptable → vue de rendu. */
export function trialBalanceView(tb: TrialBalance, currency: string): TrialBalanceView {
  return {
    fiscalYearCode: tb.fiscalYearCode,
    from: tb.from,
    to: tb.to,
    currency,
    rows: tb.rows.map((r) => ({ accountNumber: r.accountNumber, label: r.label, debit: r.debit, credit: r.credit })),
    totalDebit: tb.totalDebit,
    totalCredit: tb.totalCredit,
  };
}

export interface LedgerViewOptions {
  fiscalYearCode: string;
  from: string;
  to: string;
  currency: string;
  /** Intitulés des comptes (numéro → libellé) ; sinon le libellé reste vide. */
  accountLabels?: ReadonlyMap<string, string> | Record<string, string>;
  /** Ne garder que ce compte (ou ce préfixe de compte). */
  accountNumber?: string;
}

/**
 * Écritures (validées) → grand livre par compte, lignes triées par date puis
 * numéro d'écriture. Une écriture apparaît sous chacun de ses comptes.
 */
export function ledgerViewFromEntries(entries: JournalEntry[], opts: LedgerViewOptions): LedgerView {
  const labelOf = (n: string): string => (opts.accountLabels instanceof Map ? opts.accountLabels.get(n) : (opts.accountLabels as Record<string, string> | undefined)?.[n]) ?? "";
  const byAccount = new Map<string, LedgerLineView[]>();
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.journalCode.localeCompare(b.journalCode) || (a.number ?? 0) - (b.number ?? 0));
  for (const e of sorted) {
    for (const l of e.lines) {
      if (opts.accountNumber && !l.accountNumber.startsWith(opts.accountNumber)) continue;
      const list = byAccount.get(l.accountNumber) ?? [];
      list.push({
        date: e.date,
        journalCode: e.journalCode,
        entryNumber: e.number,
        reference: e.reference,
        label: l.label || e.label,
        debit: l.debit,
        credit: l.credit,
        ...(l.partnerId ? { partnerId: l.partnerId } : {}),
      });
      byAccount.set(l.accountNumber, list);
    }
  }
  const accounts: LedgerAccountView[] = [...byAccount.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountNumber, lines]) => {
      const totalDebit = lines.reduce((acc, l) => acc.add(Money.parse(l.debit)), Money.zero());
      const totalCredit = lines.reduce((acc, l) => acc.add(Money.parse(l.credit)), Money.zero());
      return { accountNumber, label: labelOf(accountNumber), lines, totalDebit, totalCredit, balance: totalDebit.sub(totalCredit) };
    });
  return { fiscalYearCode: opts.fiscalYearCode, from: opts.from, to: opts.to, currency: opts.currency, accounts };
}
