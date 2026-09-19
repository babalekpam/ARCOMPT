export type LedgerErrorCode =
  | "UNBALANCED"
  | "EMPTY_ENTRY"
  | "LINE_BOTH_SIDES"
  | "LINE_NO_AMOUNT"
  | "LINE_NEGATIVE"
  | "UNKNOWN_ACCOUNT"
  | "ACCOUNT_NOT_POSTABLE"
  | "ACCOUNT_INACTIVE"
  | "PARTNER_REQUIRED"
  | "UNKNOWN_JOURNAL"
  | "NO_OPEN_PERIOD"
  | "PERIOD_LOCKED"
  | "ENTRY_IMMUTABLE"
  | "ENTRY_NOT_FOUND"
  | "ALREADY_REVERSED"
  | "NOT_VALIDATED"
  | "INVALID_DATE"
  | "TENANT_MISMATCH"
  | "HASH_CHAIN_BROKEN"
  | "IMPORT_UNMAPPED_ACCOUNT"
  | "IMPORT_UNBALANCED";

export class LedgerError extends Error {
  override name = "LedgerError";
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ValidationIssue {
  code: LedgerErrorCode;
  message: string;
  lineNo?: number;
}

export class EntryValidationError extends LedgerError {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues[0]?.code ?? "UNBALANCED", issues.map((i) => i.message).join(" ; "), { issues });
  }
}
