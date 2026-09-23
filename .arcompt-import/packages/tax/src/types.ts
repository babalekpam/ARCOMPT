// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Id, Money } from "@arcompt/ledger";
import type { StatementsOutput } from "@arcompt/statements";

export type TaxReturnKind = "VAT" | "IS_INSTALMENT" | "WITHHOLDING" | "DSF";
export type TaxReturnStatus = "DRAFT" | "COMPUTED" | "VALIDATED" | "FILED";

/** Déclaration (table tax_return). `data` est le détail du calcul, montants en chaînes. */
export interface TaxReturn {
  id: Id;
  tenantId: Id;
  kind: TaxReturnKind;
  periodFrom: string;
  periodTo: string;
  status: TaxReturnStatus;
  data: Record<string, unknown>;
  amountDue: Money;
  entryId: Id | null;
  paymentEntryId: Id | null;
  filingReference: string | null;
  filedAt: string | null;
  /**
   * Faux quand la déclaration a été produite depuis un pack pays non PUBLISHED,
   * sous `ALLOW_INSECURE_DRAFT_PACK_FILINGS=1` : document non officiel.
   */
  official: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Ligne de TVA agrégée (compte, code TVA, mouvements). */
export interface VatLine {
  accountNumber: string;
  vatCode: string | null;
  debit: Money;
  credit: Money;
}

/** Comptes de liquidation de TVA ; surchargés par le pack ou le dossier. */
export interface VatAccounts {
  collected: string;
  deductible: string;
  /** TVA due (créditeur). */
  due: string;
  /** Crédit de TVA à reporter (débiteur) ; peut être le même compte que `due`. */
  credit: string;
}

export const DEFAULT_VAT_ACCOUNTS: VatAccounts = { collected: "443", deductible: "445", due: "444", credit: "444" };

export interface VatCodeAmount {
  vatCode: string;
  /** Taux du pack (null si inconnu). */
  rate: string | null;
  /** Base hors taxe reconstituée depuis le taux (null si taux inconnu ou nul). */
  base: Money | null;
  amount: Money;
}

export interface VatReturnComputation {
  periodFrom: string;
  periodTo: string;
  collected: VatCodeAmount[];
  deductible: VatCodeAmount[];
  totalCollected: Money;
  totalDeductible: Money;
  /** TVA collectée − TVA déductible (signée). */
  net: Money;
  previousCredit: Money;
  /** À payer (≥ 0). */
  amountDue: Money;
  /** Crédit à reporter (≥ 0). */
  creditCarried: Money;
}

export interface IsInstalment {
  n: number;
  amount: Money;
  dueDate: string | null;
}

export interface IsComputation {
  fiscalResult: Money;
  turnover: Money;
  /** Impôt sur les bénéfices (règle is.amount). */
  isAmount: Money;
  /** Impôt minimum forfaitaire (règle imf.amount). */
  imfAmount: Money;
  /** Impôt dû (règle is.due). */
  due: Money;
  instalments: IsInstalment[];
}

export interface WithholdingRow {
  entryId: Id;
  date: string;
  reference: string | null;
  entryLabel: string;
  lineLabel: string;
  accountNumber: string;
  partnerId: Id | null;
  partnerName: string | null;
  /** Retenue constatée (crédit) ou reversée (débit). */
  withheld: Money;
  paid: Money;
}

export interface WithholdingRegister {
  from: string;
  to: string;
  rows: WithholdingRow[];
  totalWithheld: Money;
  totalPaid: Money;
  /** Solde restant à reverser à l'État. */
  balance: Money;
}

export interface DsfAdjustments {
  reintegrations: string | Money;
  deductions: string | Money;
}

export interface DsfFiscal {
  accountingResult: Money;
  reintegrations: Money;
  deductions: Money;
  fiscalResult: Money;
  turnover: Money;
  isAmount: Money;
  imfAmount: Money;
  isDue: Money;
  /** Version des règles appliquées (source légale) pour la traçabilité. */
  rules: Array<{ id: string; source: string | null; validFrom: string }>;
}

export interface DsfResult {
  fiscalYearCode: string;
  packCode: string;
  packVersion: string;
  label: string;
  statements: StatementsOutput;
  fiscal: DsfFiscal;
  /** Vrai seulement si le pack pays est PUBLISHED et revu. */
  official: boolean;
  /** Mention « DOCUMENT NON OFFICIEL » à porter sur la liasse ; `null` si officielle. */
  notice: string | null;
}

export type DeadlineStatus = "UPCOMING" | "DUE_SOON" | "OVERDUE" | "DONE";

export interface Deadline {
  calendarId: string;
  label: string;
  frequency: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  /** Période déclarée. */
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  dueDate: string;
  status: DeadlineStatus;
  /** Déclaration correspondante (si déposée). */
  kind: TaxReturnKind | null;
}

export type TaxErrorCode = "NOT_FOUND" | "INVALID_STATE" | "INVALID_INPUT" | "FISCAL_YEAR_NOT_FOUND" | "PACK_REQUIRED" | "PACK_NOT_PUBLISHED";

export class TaxError extends Error {
  override name = "TaxError";
  constructor(
    readonly code: TaxErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
