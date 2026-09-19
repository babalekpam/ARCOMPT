/** Types des réponses de l'API clôture (/v1/closing), copiés du paquet serveur. */
export type ChecklistStatus = "TODO" | "DONE" | "NA";

export interface ChecklistItem {
  id: string;
  tenantId: string;
  fiscalYearId: string;
  periodId: string | null;
  key: string;
  label: string;
  blocking: boolean;
  status: ChecklistStatus;
  doneBy: string | null;
  doneAt: string | null;
  evidence: Record<string, unknown>;
}

export type WorkflowState = "TENUE" | "REVISION" | "ETATS" | "VISA" | "DEPOT" | "VERROUILLE";
export const WORKFLOW_STATES: WorkflowState[] = ["TENUE", "REVISION", "ETATS", "VISA", "DEPOT", "VERROUILLE"];

export interface WorkflowHistoryEntry {
  from: WorkflowState;
  to: WorkflowState;
  by: string;
  at: string;
  comment: string | null;
}

export interface FiscalYearWorkflow {
  id: string;
  tenantId: string;
  fiscalYearId: string;
  fiscalYearCode: string;
  state: WorkflowState;
  history: WorkflowHistoryEntry[];
  reviewerId: string | null;
  approverId: string | null;
  filingReceiptDocumentId: string | null;
  updatedAt: string;
}

export type PeriodStatus = "OPEN" | "CLOSED" | "LOCKED";

export interface PeriodInfo {
  id: string;
  fiscalYearId: string;
  fiscalYearCode: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  isLast: boolean;
}

export interface FiscalYearRow {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
}
