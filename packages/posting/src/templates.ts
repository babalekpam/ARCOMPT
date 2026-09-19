import type { PostingEvent, PostingEventKind, PostingTemplate } from "./types.js";

/** Journal de trésorerie : caisse (57x) → CA, sinon banque (521, 5381…) → BQ. */
export function treasuryJournal(event: PostingEvent): string {
  return event.treasuryAccountNumber?.startsWith("57") ? "CA" : "BQ";
}

/**
 * Modèles d'imputation par défaut (SYSCOHADA révisé). Chaque modèle est une
 * donnée : le dossier peut le surcharger (autre journal, sous-comptes) sans
 * toucher au code.
 */
export const DEFAULT_TEMPLATES: Record<PostingEventKind, PostingTemplate> = {
  // Facture de vente : 411 (TTC) à 70x (HT par compte) et 443 (TVA par code).
  SALES_INVOICE: {
    kind: "SALES_INVOICE",
    journalCode: "VT",
    source: "INVOICE",
    lines: [
      { role: "customer", side: "debit", amount: "total_gross", partner: "event" },
      { role: "revenue", side: "credit", amount: "line_net", group: "account" },
      { role: "vat_collected", side: "credit", amount: "line_vat", group: "vat_code", withVatCode: true, label: "TVA collectée {label}" },
    ],
  },
  // Avoir client : sens inverse de la facture.
  SALES_CREDIT_NOTE: {
    kind: "SALES_CREDIT_NOTE",
    journalCode: "VT",
    source: "INVOICE",
    lines: [
      { role: "revenue", side: "debit", amount: "line_net", group: "account" },
      { role: "vat_collected", side: "debit", amount: "line_vat", group: "vat_code", withVatCode: true, label: "TVA collectée {label}" },
      { role: "customer", side: "credit", amount: "total_gross", partner: "event" },
    ],
  },
  // Encaissement client : 521 / 571 / 5381 à 411.
  CUSTOMER_PAYMENT: {
    kind: "CUSTOMER_PAYMENT",
    journalCode: treasuryJournal,
    source: "BANK",
    lines: [
      { role: "treasury", side: "debit", amount: { field: "amount" } },
      { role: "customer", side: "credit", amount: { field: "amount" }, partner: "event" },
    ],
  },
  // Facture fournisseur : 6xx (HT par ligne) et 445 (TVA par code) à 401 (TTC).
  PURCHASE_INVOICE: {
    kind: "PURCHASE_INVOICE",
    journalCode: "AC",
    source: "PURCHASE",
    lines: [
      { role: "expense", side: "debit", amount: "line_net", group: "line", label: "{line}" },
      { role: "vat_deductible", side: "debit", amount: "line_vat", group: "vat_code", withVatCode: true, label: "TVA déductible {label}" },
      { role: "supplier", side: "credit", amount: "total_gross", partner: "event" },
    ],
  },
  // Avoir fournisseur : sens inverse.
  PURCHASE_CREDIT_NOTE: {
    kind: "PURCHASE_CREDIT_NOTE",
    journalCode: "AC",
    source: "PURCHASE",
    lines: [
      { role: "supplier", side: "debit", amount: "total_gross", partner: "event" },
      { role: "expense", side: "credit", amount: "line_net", group: "line", label: "{line}" },
      { role: "vat_deductible", side: "credit", amount: "line_vat", group: "vat_code", withVatCode: true, label: "TVA déductible {label}" },
    ],
  },
  // Décaissement fournisseur : 401 à 521 / 571 / 5381.
  SUPPLIER_PAYMENT: {
    kind: "SUPPLIER_PAYMENT",
    journalCode: treasuryJournal,
    source: "BANK",
    lines: [
      { role: "supplier", side: "debit", amount: { field: "amount" }, partner: "event" },
      { role: "treasury", side: "credit", amount: { field: "amount" } },
    ],
  },
  // Note de frais : charges (et TVA déductible) à 421 salarié.
  EXPENSE_CLAIM: {
    kind: "EXPENSE_CLAIM",
    journalCode: "AC",
    source: "PURCHASE",
    lines: [
      { role: "expense", side: "debit", amount: "line_net", group: "line", label: "{line}" },
      { role: "vat_deductible", side: "debit", amount: "line_vat", group: "vat_code", withVatCode: true, label: "TVA déductible {label}" },
      { role: "employee", side: "credit", amount: "total_gross", partner: "event" },
    ],
  },
  // Paie : 661 brut + 664 charges patronales à 422 net par salarié (lignes), 431 organismes, 447 ITS.
  // Montants attendus : gross, employer_contributions, social_contributions (salariales + patronales), income_tax.
  PAYROLL_RUN: {
    kind: "PAYROLL_RUN",
    journalCode: "PA",
    source: "PAYROLL",
    lines: [
      { role: "salary_expense", side: "debit", amount: { field: "gross" }, label: "Salaires bruts {label}" },
      { role: "social_expense", side: "debit", amount: { field: "employer_contributions" }, label: "Charges sociales patronales {label}" },
      { role: "social_body", side: "credit", amount: { field: "social_contributions" }, label: "Cotisations sociales {label}" },
      { role: "withholding_tax", side: "credit", amount: { field: "income_tax" }, label: "Impôt sur salaires retenu {label}" },
      { role: "salary_payable", side: "credit", amount: "line_net", group: "line", partner: "line", label: "Net à payer {line}" },
    ],
  },
  // Liquidation de TVA : 443 (collectée) à 445 (déductible), solde en 444 (dette ou crédit).
  VAT_SETTLEMENT: {
    kind: "VAT_SETTLEMENT",
    journalCode: "OD",
    source: "TAX",
    lines: [
      { role: "vat_collected", side: "debit", amount: { field: "vat_collected" }, label: "TVA collectée {label}" },
      { role: "vat_deductible", side: "credit", amount: { field: "vat_deductible" }, label: "TVA déductible {label}" },
      { role: "vat_due", side: "credit", amount: "balance", label: "TVA due {label}" },
    ],
  },
  // Dotation aux amortissements : 681 à 28xx (compte de chaque ligne).
  DEPRECIATION: {
    kind: "DEPRECIATION",
    journalCode: "OD",
    source: "CLOSING",
    lines: [
      { role: "depreciation_expense", side: "debit", amount: "line_net", group: "line", label: "Dotation {line}" },
      { role: "depreciation", side: "credit", amount: "line_net", group: "line", label: "Amortissement {line}" },
    ],
  },
};
