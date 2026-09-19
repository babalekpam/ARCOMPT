export type DocumentsErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "PROPOSAL_NOT_FOUND"
  | "NOT_EXTRACTED"
  | "NEEDS_OCR"
  | "NO_AMOUNT"
  | "UNSUPPORTED_MIME"
  | "PROPOSAL_NOT_PENDING"
  | "PROPOSAL_REJECTED_BY_GUARD"
  | "INVALID_LINES"
  | "UNKNOWN_TOOL"
  | "EMPTY_FILE"
  | "INFECTED"
  | "TOO_LARGE";

export class DocumentsError extends Error {
  override name = "DocumentsError";
  constructor(
    readonly code: DocumentsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Statut HTTP conseillé pour une erreur métier du module. */
export function documentsErrorStatus(code: DocumentsErrorCode): 400 | 404 | 409 | 422 {
  switch (code) {
    case "DOCUMENT_NOT_FOUND":
    case "PROPOSAL_NOT_FOUND":
      return 404;
    case "PROPOSAL_NOT_PENDING":
      return 409;
    case "INVALID_LINES":
    case "UNSUPPORTED_MIME":
    case "EMPTY_FILE":
    case "UNKNOWN_TOOL":
      return 400;
    default:
      return 422;
  }
}
