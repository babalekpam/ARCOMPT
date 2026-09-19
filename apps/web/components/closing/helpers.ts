/** Aides pures du module clôture (testables sans React ni réseau). */
import type { BadgeTone } from "@/components/ui/Badge";
import type { ChecklistItem, PeriodStatus, WorkflowState } from "./types";

export interface WorkflowEdge {
  from: WorkflowState;
  to: WorkflowState;
  /** Clé de message du libellé de l'action. */
  labelKey: string;
  /** Retour en arrière (corrections / rejet). */
  backward: boolean;
  /** Le commentaire est attendu (rejet, corrections). */
  commentHint: boolean;
  /** L'accusé de dépôt (document) est requis. */
  receiptRequired: boolean;
}

/** Miroir de la machine à états serveur (packages/closing/src/workflow.ts). L'API reste seule juge des rôles. */
export const WORKFLOW_EDGES: WorkflowEdge[] = [
  { from: "TENUE", to: "REVISION", labelKey: "closing.transition.TENUE_REVISION", backward: false, commentHint: false, receiptRequired: false },
  { from: "REVISION", to: "TENUE", labelKey: "closing.transition.REVISION_TENUE", backward: true, commentHint: true, receiptRequired: false },
  { from: "REVISION", to: "ETATS", labelKey: "closing.transition.REVISION_ETATS", backward: false, commentHint: false, receiptRequired: false },
  { from: "ETATS", to: "VISA", labelKey: "closing.transition.ETATS_VISA", backward: false, commentHint: false, receiptRequired: false },
  { from: "VISA", to: "REVISION", labelKey: "closing.transition.VISA_REVISION", backward: true, commentHint: true, receiptRequired: false },
  { from: "VISA", to: "DEPOT", labelKey: "closing.transition.VISA_DEPOT", backward: false, commentHint: false, receiptRequired: false },
  { from: "DEPOT", to: "VERROUILLE", labelKey: "closing.transition.DEPOT_VERROUILLE", backward: false, commentHint: false, receiptRequired: true },
];

export function allowedTransitions(state: WorkflowState): WorkflowEdge[] {
  return WORKFLOW_EDGES.filter((e) => e.from === state);
}

export function periodTone(status: PeriodStatus): BadgeTone {
  return status === "OPEN" ? "success" : status === "CLOSED" ? "warning" : "neutral";
}

export function checklistTone(status: ChecklistItem["status"]): BadgeTone {
  return status === "DONE" ? "success" : status === "NA" ? "neutral" : "warning";
}

/** Avancement d'une liste : items traités (DONE ou NA) et bloquants restant à faire. */
export function checklistProgress(items: Pick<ChecklistItem, "status" | "blocking">[]): { done: number; total: number; blockingTodo: number } {
  let done = 0;
  let blockingTodo = 0;
  for (const i of items) {
    if (i.status !== "TODO") done += 1;
    else if (i.blocking) blockingTodo += 1;
  }
  return { done, total: items.length, blockingTodo };
}

/** Note libre stockée dans `evidence.note` (chaîne), sinon vide. */
export function evidenceNote(evidence: Record<string, unknown> | null | undefined): string {
  const n = evidence?.note;
  return typeof n === "string" ? n : "";
}

/** Libellé d'une période mensuelle « 2025-03 » depuis ses bornes. */
export function periodCode(startDate: string): string {
  return startDate.slice(0, 7);
}
