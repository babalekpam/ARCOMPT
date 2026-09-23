// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { StatementsOutput } from "@arcompt/statements";
import { renderBankReconciliation } from "./templates/bank-reconciliation.js";
import { renderInvoice } from "./templates/invoice.js";
import { renderLedger } from "./templates/ledger.js";
import { renderPayslip } from "./templates/payslip.js";
import { renderStatements } from "./templates/statements.js";
import { renderTrialBalance } from "./templates/trial-balance.js";
import type { BankReconciliationView, InvoiceView, LedgerView, PayslipView, RenderOptions, TrialBalanceView } from "./views.js";

/** Données attendues par chaque gabarit. */
export interface RenderInputs {
  statements: StatementsOutput;
  "trial-balance": TrialBalanceView;
  ledger: LedgerView;
  invoice: InvoiceView;
  payslip: PayslipView;
  "bank-reconciliation": BankReconciliationView;
}

export type RenderKind = keyof RenderInputs;

/** Rend un document HTML autonome (style inclus) prêt pour `renderPdf`. */
export function renderHtml<K extends RenderKind>(kind: K, data: RenderInputs[K], opts: RenderOptions = {}): string {
  switch (kind) {
    case "statements":
      return renderStatements(data as StatementsOutput, opts);
    case "trial-balance":
      return renderTrialBalance(data as TrialBalanceView, opts);
    case "ledger":
      return renderLedger(data as LedgerView, opts);
    case "invoice":
      return renderInvoice(data as InvoiceView, opts);
    case "payslip":
      return renderPayslip(data as PayslipView, opts);
    case "bank-reconciliation":
      return renderBankReconciliation(data as BankReconciliationView, opts);
    default:
      throw new Error(`Gabarit inconnu : ${String(kind)}`);
  }
}
