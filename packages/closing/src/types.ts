import type { Id } from "@arcompt/ledger";

export type ChecklistStatus = "TODO" | "DONE" | "NA";
export type ChecklistScope = "MONTHLY" | "ANNUAL";

export interface ChecklistTemplateItem {
  key: string;
  label: string;
  /** Un item bloquant laissé TODO empêche la clôture. */
  blocking: boolean;
}

export interface ChecklistItem {
  id: Id;
  tenantId: Id;
  fiscalYearId: Id;
  /** null pour la liste annuelle. */
  periodId: Id | null;
  key: string;
  label: string;
  blocking: boolean;
  status: ChecklistStatus;
  doneBy: Id | null;
  doneAt: string | null;
  evidence: Record<string, unknown>;
}

export type WorkflowState = "TENUE" | "REVISION" | "ETATS" | "VISA" | "DEPOT" | "VERROUILLE";

export interface WorkflowHistoryEntry {
  from: WorkflowState;
  to: WorkflowState;
  by: Id;
  at: string;
  comment: string | null;
}

export interface FiscalYearWorkflow {
  id: Id;
  tenantId: Id;
  fiscalYearId: Id;
  fiscalYearCode: string;
  state: WorkflowState;
  history: WorkflowHistoryEntry[];
  reviewerId: Id | null;
  approverId: Id | null;
  filingReceiptDocumentId: Id | null;
  updatedAt: string;
}

export interface PeriodInfo {
  id: Id;
  fiscalYearId: Id;
  fiscalYearCode: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED" | "LOCKED";
  /** Dernière période de l'exercice : sa clôture est la clôture annuelle. */
  isLast: boolean;
}

export type ClosingErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "CHECKLIST_INCOMPLETE"
  | "CONTROLS_FAILED"
  | "PERIODS_OPEN"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "SEPARATION_OF_DUTIES"
  | "RECEIPT_REQUIRED"
  | "COMMENT_REQUIRED"
  | "INVALID_INPUT";

export class ClosingError extends Error {
  override name = "ClosingError";
  constructor(
    readonly code: ClosingErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
