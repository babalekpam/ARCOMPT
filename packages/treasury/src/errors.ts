export type TreasuryErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_IN_USE"
  | "UNKNOWN_CHART_ACCOUNT"
  | "STATEMENT_NOT_FOUND"
  | "DUPLICATE_STATEMENT"
  | "EMPTY_STATEMENT"
  | "PARSE_ERROR"
  | "TRANSACTION_NOT_FOUND"
  | "INVALID_STATE"
  | "LINE_NOT_FOUND"
  | "LINE_ALREADY_MATCHED"
  | "AMOUNT_MISMATCH"
  | "RULE_NOT_FOUND"
  | "INVALID_INPUT";

export class TreasuryError extends Error {
  override name = "TreasuryError";
  constructor(
    readonly code: TreasuryErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Statut HTTP conseillé par code d'erreur (utilisé par la route API). */
export function httpStatusOf(code: TreasuryErrorCode): 400 | 404 | 409 | 422 {
  switch (code) {
    case "ACCOUNT_NOT_FOUND":
    case "STATEMENT_NOT_FOUND":
    case "TRANSACTION_NOT_FOUND":
    case "LINE_NOT_FOUND":
    case "RULE_NOT_FOUND":
      return 404;
    case "DUPLICATE_STATEMENT":
    case "INVALID_STATE":
    case "LINE_ALREADY_MATCHED":
    case "ACCOUNT_IN_USE":
      return 409;
    case "INVALID_INPUT":
    case "PARSE_ERROR":
      return 400;
    default:
      return 422;
  }
}
