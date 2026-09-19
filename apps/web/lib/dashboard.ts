/** Agrégats du tableau de bord calculés sur la balance (chaînes, jamais de flottant). */
import { addAmounts, negate, subAmounts } from "./money";
import type { TrialBalance } from "./types";

export interface DashboardKpis {
  /** Solde net des comptes de classe 5 (banques, caisses, mobile money). */
  cash: string;
  /** Créances clients : soldes débiteurs des comptes 411. */
  receivables: string;
  /** Dettes fournisseurs : soldes créditeurs des comptes 401. */
  payables: string;
  /** Produits (classe 7) moins charges (classe 6). */
  result: string;
  income: string;
  expenses: string;
}

export function computeDashboard(tb: Pick<TrialBalance, "rows">): DashboardKpis {
  let cash = "0";
  let receivables = "0";
  let payables = "0";
  let income = "0";
  let expenses = "0";
  for (const r of tb.rows) {
    const net = subAmounts(r.debit, r.credit); // solde débiteur positif
    if (r.accountNumber.startsWith("5")) cash = addAmounts(cash, net);
    else if (r.accountNumber.startsWith("411")) receivables = addAmounts(receivables, net);
    else if (r.accountNumber.startsWith("401")) payables = addAmounts(payables, negate(net));
    else if (r.accountNumber.startsWith("7")) income = addAmounts(income, negate(net));
    else if (r.accountNumber.startsWith("6")) expenses = addAmounts(expenses, net);
  }
  return { cash, receivables, payables, result: subAmounts(income, expenses), income, expenses };
}
