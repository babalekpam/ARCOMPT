/**
 * Types des réponses de l'API « pièces & IA » (/documents, /proposals,
 * /assistant/ask, /anomalies). Copiés des paquets serveur : les montants sont
 * des chaînes décimales, jamais des flottants.
 */
export type DocumentSource = "UPLOAD" | "WHATSAPP" | "EMAIL" | "BANK";
export type DocumentStatus = "UPLOADED" | "EXTRACTED" | "NEEDS_OCR" | "PROPOSED" | "POSTED" | "REJECTED";
export type ProposalRoute = "ONE_TAP_VALIDATION" | "REVIEW_QUEUE" | "REJECTED";
export type ProposalStatus = "PENDING" | "VALIDATED" | "CORRECTED" | "REJECTED";
export type DocumentType = "INVOICE" | "RECEIPT" | "BANK_STATEMENT" | "PAYSLIP" | "OTHER";

export interface GuardIssue {
  code: string;
  message: string;
}

export interface DocumentExtraction {
  document_type: DocumentType;
  supplier_name: string | null;
  supplier_tax_id: string | null;
  customer_name: string | null;
  reference: string | null;
  date: string | null;
  currency: string | null;
  amount_excl_tax: string | null;
  vat_amount: string | null;
  amount_incl_tax: string | null;
  lines: Array<{ description: string; quantity: string | null; unit_price: string | null; amount: string | null }>;
  confidence: number;
  notes: string | null;
}

export interface ExtractedData extends DocumentExtraction {
  duplicate_key?: string | null;
  duplicate_of?: { document_id?: string; proposal_id?: string } | null;
  issues?: GuardIssue[];
  needs_ocr?: boolean;
  extracted_at?: string;
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

export interface ProposalLine {
  account_number: string;
  debit?: string;
  credit?: string;
  label?: string;
  vat_code?: string;
  partner_id?: string;
  partner_name?: string;
  account_label?: string;
}

export interface StoredProposal {
  journal_code: string;
  date: string;
  label: string;
  lines: ProposalLine[];
  confidence: number;
  rationale: string;
  alternatives: Array<{ account_number: string; rationale: string }>;
  reference?: string | null;
  categorized_by?: "RULE" | "MEMORY" | "LLM" | "MANUAL";
}

export interface ProposalRecord {
  id: string;
  tenantId: string;
  documentId: string | null;
  source: DocumentSource;
  kind: "ENTRY" | "CATEGORIZATION" | "MATCH";
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

export interface UploadResult {
  document: DocumentRecord;
  duplicate: boolean;
}

export interface ExtractResult {
  document: DocumentRecord;
  extraction: DocumentExtraction | null;
  issues: GuardIssue[];
  needsOcr: boolean;
}

export interface ReviewQueueGroup {
  document: DocumentRecord | null;
  proposals: ProposalRecord[];
}

export interface DecisionResult {
  proposal: ProposalRecord;
  entry: { id: string; number: number | null; journalCode: string };
}

export interface BulkValidateItem {
  id: string;
  ok: boolean;
  entryId?: string;
  error?: { code: string; message: string };
}

export type AssistantToolName = "get_aged_receivables" | "get_aged_payables" | "get_cash_position" | "get_trial_balance" | "get_vat_summary" | "explain_statement_line";

export interface AssistantAnswer {
  answer: string;
  tool: AssistantToolName;
  arguments: Record<string, unknown>;
  data: unknown;
}

export type AnomalyCode = "NEGATIVE_CASH" | "VAT_INCONSISTENT" | "DUPLICATE_INVOICE" | "UNUSUAL_AMOUNT";

export interface Anomaly {
  code: AnomalyCode;
  severity: "WARNING" | "ERROR";
  message: string;
  entryIds: string[];
  accountNumber?: string;
  date?: string;
  amount?: string;
}

export interface AnomaliesResponse {
  period: { from: string; to: string };
  anomalies: Anomaly[];
}
