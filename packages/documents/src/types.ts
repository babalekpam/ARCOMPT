// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { DocumentExtraction, EntryProposal, GuardIssue } from "@arcompt/ai-gateway";

export interface TenantContext {
  tenantId: string;
  userId: string;
  organizationId?: string;
}

export type DocumentSource = "UPLOAD" | "WHATSAPP" | "EMAIL" | "BANK";
export type DocumentStatus = "UPLOADED" | "EXTRACTED" | "NEEDS_OCR" | "PROPOSED" | "POSTED" | "REJECTED";
export type ProposalKind = "ENTRY" | "CATEGORIZATION" | "MATCH";
export type ProposalRoute = "ONE_TAP_VALIDATION" | "REVIEW_QUEUE" | "REJECTED";
export type ProposalStatus = "PENDING" | "VALIDATED" | "CORRECTED" | "REJECTED";

/** Données lues par l'IA, enrichies des contrôles ; jamais une vérité comptable. */
export interface ExtractedData extends DocumentExtraction {
  duplicate_key?: string | null;
  duplicate_of?: { document_id?: string; proposal_id?: string } | null;
  issues?: GuardIssue[];
  needs_ocr?: boolean;
  extracted_at?: string;
  prompt_version?: string;
}

export interface DocumentRecord {
  id: string;
  tenantId: string;
  entryId: string | null;
  storageKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  filename: string | null;
  source: DocumentSource;
  status: DocumentStatus;
  extracted: ExtractedData | null;
  uploadedBy: string;
  createdAt: string;
}

/** Ligne de proposition : EntryProposal + tiers résolu côté serveur. */
export type ProposalLine = EntryProposal["lines"][number] & { partner_id?: string; partner_name?: string; account_label?: string };

export interface StoredProposal extends Omit<EntryProposal, "lines"> {
  lines: ProposalLine[];
  reference?: string | null;
  /** Origine de la catégorisation : règle du dossier, mémoire, modèle. */
  categorized_by?: "RULE" | "MEMORY" | "LLM" | "MANUAL";
}

export interface ProposalRecord {
  id: string;
  tenantId: string;
  documentId: string | null;
  source: DocumentSource;
  kind: ProposalKind;
  extraction: ExtractedData | null;
  proposal: StoredProposal;
  confidence: number;
  guardIssues: GuardIssue[];
  route: ProposalRoute;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  entryId: string | null;
  correction: ProposalLine[] | null;
  createdAt: string;
}

export interface CategorizationInput {
  partnerName: string | null;
  description: string;
  amount?: string | null;
  documentType?: DocumentExtraction["document_type"];
}

export interface CategorizationResult {
  accountNumber: string;
  vatCode: string | null;
  confidence: number;
  rationale: string;
  by: "RULE" | "MEMORY" | "LLM";
}

export interface ChartAccountInfo {
  number: string;
  label: string;
  postable: boolean;
  lettrable: boolean;
  active: boolean;
}
