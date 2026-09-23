// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Aides pures du module pièces & IA (testables sans React ni réseau) :
 * tonalités des badges, confiance, liste des pièces dérivée de la file de
 * revue (l'API n'expose pas de liste de pièces), contrôle des lignes corrigées.
 */
import type { BadgeTone } from "@/components/ui/Badge";
import { addAmounts, compareAmounts, normalizeInput } from "../../lib/money";
import type { DocumentRecord, DocumentStatus, ProposalLine, ProposalRecord, ProposalRoute, ProposalStatus, ReviewQueueGroup } from "./types";

export const PROPOSAL_STATUSES: ProposalStatus[] = ["PENDING", "VALIDATED", "CORRECTED", "REJECTED"];
export const ACCEPTED_MIME_PREFIXES = ["image/", "application/pdf"];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function documentStatusTone(status: DocumentStatus): BadgeTone {
  switch (status) {
    case "POSTED":
      return "success";
    case "PROPOSED":
    case "EXTRACTED":
      return "info";
    case "NEEDS_OCR":
      return "warning";
    case "REJECTED":
      return "danger";
    default:
      return "neutral";
  }
}

export function routeTone(route: ProposalRoute): BadgeTone {
  return route === "ONE_TAP_VALIDATION" ? "success" : route === "REVIEW_QUEUE" ? "warning" : "danger";
}

export function proposalStatusTone(status: ProposalStatus): BadgeTone {
  return status === "VALIDATED" || status === "CORRECTED" ? "success" : status === "REJECTED" ? "danger" : "warning";
}

/** Confiance 0..1 → "92 %" (entier, espace insécable). */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return `${pct}\u00a0%`;
}

/** ≥ 85 % : validation en un geste ; ≥ 60 % : revue ; sinon faible. */
export function confidenceTone(value: number | null | undefined): BadgeTone {
  if (value === null || value === undefined) return "neutral";
  return value >= 0.85 ? "success" : value >= 0.6 ? "warning" : "danger";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

/** Type accepté à l'envoi : images et PDF (le type réel est relu par l'API). */
export function isAcceptedFile(file: { type: string; name: string; size: number }): boolean {
  if (file.size > MAX_UPLOAD_BYTES) return false;
  if (ACCEPTED_MIME_PREFIXES.some((p) => file.type.startsWith(p))) return true;
  return /\.(pdf|png|jpe?g|webp)$/i.test(file.name);
}

export interface DocumentListItem {
  document: DocumentRecord;
  /** Dernière proposition connue pour cette pièce (la plus récente). */
  latest: ProposalRecord | null;
  pendingCount: number;
}

/**
 * Liste des pièces à partir des groupes de la file de revue (toutes routes et
 * statuts confondus) : une pièce par identifiant, triée de la plus récente à
 * la plus ancienne. Les propositions sans pièce (dépenses de caisse) sont ignorées.
 */
export function groupsToDocuments(groups: ReviewQueueGroup[]): DocumentListItem[] {
  const byId = new Map<string, DocumentListItem>();
  for (const g of groups) {
    if (!g.document) continue;
    const item = byId.get(g.document.id) ?? { document: g.document, latest: null, pendingCount: 0 };
    for (const p of g.proposals) {
      if (!item.latest || p.createdAt > item.latest.createdAt) item.latest = p;
      if (p.status === "PENDING") item.pendingCount += 1;
    }
    byId.set(g.document.id, item);
  }
  return [...byId.values()].sort((a, b) => (a.document.createdAt < b.document.createdAt ? 1 : a.document.createdAt > b.document.createdAt ? -1 : 0));
}

/** Totaux débit / crédit d'une liste de lignes (chaînes canoniques). */
export function proposalTotals(lines: Array<Pick<ProposalLine, "debit" | "credit">>): { debit: string; credit: string; balanced: boolean } {
  let debit = "0";
  let credit = "0";
  for (const l of lines) {
    if (l.debit) debit = addAmounts(debit, l.debit);
    if (l.credit) credit = addAmounts(credit, l.credit);
  }
  return { debit, credit, balanced: compareAmounts(debit, credit) === 0 && debit !== "0.0000" };
}

export interface EditableLine {
  key: string;
  account_number: string;
  label: string;
  debit: string;
  credit: string;
  vat_code: string;
}

export type CorrectionError = "MIN_LINES" | "ACCOUNT" | "AMOUNT" | "UNBALANCED";

/** Lignes du formulaire de correction → corps de POST /proposals/:id/correct, ou code d'erreur. */
export function buildCorrection(lines: EditableLine[]): { ok: true; lines: ProposalLine[] } | { ok: false; error: CorrectionError } {
  if (lines.length < 2) return { ok: false, error: "MIN_LINES" };
  const out: ProposalLine[] = [];
  for (const l of lines) {
    if (!/^[1-9]\d{1,12}$/.test(l.account_number.trim())) return { ok: false, error: "ACCOUNT" };
    const d = normalizeInput(l.debit);
    const c = normalizeInput(l.credit);
    if ((!d && !c) || (d && c)) return { ok: false, error: "AMOUNT" };
    out.push({
      account_number: l.account_number.trim(),
      ...(d ? { debit: d } : {}),
      ...(c ? { credit: c } : {}),
      ...(l.label.trim() ? { label: l.label.trim() } : {}),
      ...(l.vat_code.trim() ? { vat_code: l.vat_code.trim() } : {}),
    });
  }
  if (!proposalTotals(out).balanced) return { ok: false, error: "UNBALANCED" };
  return { ok: true, lines: out };
}

/** Lignes d'une proposition → lignes éditables (pré-remplissage de la correction). */
export function toEditableLines(lines: ProposalLine[]): EditableLine[] {
  return lines.map((l, i) => ({
    key: `l${i}-${l.account_number}`,
    account_number: l.account_number,
    label: l.label ?? "",
    debit: l.debit ?? "",
    credit: l.credit ?? "",
    vat_code: l.vat_code ?? "",
  }));
}

/** Période par défaut des anomalies : du 1er janvier de l'année à aujourd'hui. */
export function defaultAnomalyPeriod(today: string): { from: string; to: string } {
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO.test(v);
}
