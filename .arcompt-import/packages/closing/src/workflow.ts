// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { WorkflowState } from "./types.js";

/**
 * Machine à états de l'exercice (ARCHITECTURE.md §10) :
 * Tenue → Révision → États → Visa → Dépôt → Verrouillé, avec retours
 * Révision → Tenue (corrections) et Visa → Révision (rejet).
 */
export const WORKFLOW_STATES: WorkflowState[] = ["TENUE", "REVISION", "ETATS", "VISA", "DEPOT", "VERROUILLE"];

export interface WorkflowEdge {
  from: WorkflowState;
  to: WorkflowState;
  label: string;
  /** Rôles autorisés (vide = tout rôle pouvant écrire). */
  roles: string[];
}

const WRITERS = ["OWNER", "ACCOUNTANT", "REVIEWER"];
const APPROVERS = ["OWNER", "REVIEWER"];

export const WORKFLOW_EDGES: WorkflowEdge[] = [
  { from: "TENUE", to: "REVISION", label: "Clôture demandée", roles: WRITERS },
  { from: "REVISION", to: "TENUE", label: "Corrections", roles: WRITERS },
  { from: "REVISION", to: "ETATS", label: "Contrôles OK, états produits", roles: WRITERS },
  { from: "ETATS", to: "VISA", label: "Soumis à l'expert", roles: WRITERS },
  { from: "VISA", to: "REVISION", label: "Rejet", roles: APPROVERS },
  { from: "VISA", to: "DEPOT", label: "Visé et signé", roles: APPROVERS },
  { from: "DEPOT", to: "VERROUILLE", label: "Accusé de dépôt joint", roles: WRITERS },
];

export interface TransitionContext {
  actor: { userId: string; roles: string[] };
  /** REVISION → ETATS : les contrôles bloquants des états passent. */
  controlsOk?: boolean;
  /** VISA → DEPOT : utilisateur ayant produit les états (REVISION → ETATS) ; l'approbateur doit être différent. */
  statementsPreparedBy?: string | null;
  /** DEPOT → VERROUILLE : accusé de dépôt DGI. */
  filingReceiptDocumentId?: string | null;
}

export type TransitionCheck = { ok: true; edge: WorkflowEdge } | { ok: false; code: "INVALID_TRANSITION" | "FORBIDDEN" | "CONTROLS_FAILED" | "SEPARATION_OF_DUTIES" | "RECEIPT_REQUIRED"; message: string };

export function nextStates(from: WorkflowState): WorkflowState[] {
  return WORKFLOW_EDGES.filter((e) => e.from === from).map((e) => e.to);
}

/** Vérifie une transition : arête existante, rôle, conditions métier. Fonction pure. */
export function checkTransition(from: WorkflowState, to: WorkflowState, ctx: TransitionContext): TransitionCheck {
  const edge = WORKFLOW_EDGES.find((e) => e.from === from && e.to === to);
  if (!edge) return { ok: false, code: "INVALID_TRANSITION", message: `Transition ${from} → ${to} interdite (possibles : ${nextStates(from).join(", ") || "aucune"})` };
  if (!ctx.actor.roles.some((r) => edge.roles.includes(r))) return { ok: false, code: "FORBIDDEN", message: `Transition ${from} → ${to} : rôle requis ${edge.roles.join(" ou ")}` };
  if (to === "ETATS" && ctx.controlsOk !== true) return { ok: false, code: "CONTROLS_FAILED", message: "Les contrôles bloquants des états financiers doivent passer avant de produire les états" };
  if (to === "DEPOT" && ctx.statementsPreparedBy && ctx.statementsPreparedBy === ctx.actor.userId) {
    return { ok: false, code: "SEPARATION_OF_DUTIES", message: "Séparation des tâches : celui qui a produit les états ne peut pas les viser" };
  }
  if (to === "VERROUILLE" && !ctx.filingReceiptDocumentId) return { ok: false, code: "RECEIPT_REQUIRED", message: "L'accusé de dépôt (pièce) est requis pour verrouiller l'exercice" };
  return { ok: true, edge };
}
