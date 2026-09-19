/** Types des réponses de l'API fiscalité (/v1/tax), copiés du paquet serveur. Montants en chaînes décimales. */
import type { StatementsOutput } from "@/lib/types";

export type TaxReturnKind = "VAT" | "IS_INSTALMENT" | "WITHHOLDING" | "DSF";
export type TaxReturnStatus = "DRAFT" | "COMPUTED" | "VALIDATED" | "FILED";

export interface TaxReturn {
  id: string;
  tenantId: string;
  kind: TaxReturnKind;
  periodFrom: string;
  periodTo: string;
  status: TaxReturnStatus;
  data: Record<string, unknown>;
  amountDue: string;
  entryId: string | null;
  paymentEntryId: string | null;
  filingReference: string | null;
  filedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VatCodeAmount {
  vatCode: string;
  rate: string | null;
  base: string | null;
  amount: string;
}

export interface VatReturnComputation {
  periodFrom: string;
  periodTo: string;
  collected: VatCodeAmount[];
  deductible: VatCodeAmount[];
  totalCollected: string;
  totalDeductible: string;
  net: string;
  previousCredit: string;
  amountDue: string;
  creditCarried: string;
}

export interface IsInstalment {
  n: number;
  amount: string;
  dueDate: string | null;
}

export interface IsComputation {
  fiscalResult: string;
  turnover: string;
  isAmount: string;
  imfAmount: string;
  due: string;
  instalments: IsInstalment[];
}

export interface WithholdingRow {
  entryId: string;
  date: string;
  reference: string | null;
  entryLabel: string;
  lineLabel: string;
  accountNumber: string;
  partnerId: string | null;
  partnerName: string | null;
  withheld: string;
  paid: string;
}

export interface WithholdingRegister {
  from: string;
  to: string;
  rows: WithholdingRow[];
  totalWithheld: string;
  totalPaid: string;
  balance: string;
}

export interface DsfFiscal {
  accountingResult: string;
  reintegrations: string;
  deductions: string;
  fiscalResult: string;
  turnover: string;
  isAmount: string;
  imfAmount: string;
  isDue: string;
  rules: Array<{ id: string; source: string | null; validFrom: string }>;
}

/** Réponse de GET /tax/dsf/:fy : la déclaration créée + le résultat DSF aplati. */
export interface DsfResponse {
  taxReturn: TaxReturn;
  fiscalYearCode: string;
  packCode: string;
  packVersion: string;
  label: string;
  statements: StatementsOutput;
  fiscal: DsfFiscal;
}

export type DeadlineStatus = "UPCOMING" | "DUE_SOON" | "OVERDUE" | "DONE";

export interface Deadline {
  calendarId: string;
  label: string;
  frequency: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  dueDate: string;
  status: DeadlineStatus;
  kind: TaxReturnKind | null;
}
