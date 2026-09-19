export type PayrollErrorCode =
  | "EMPLOYEE_NOT_FOUND"
  | "EMPLOYEE_INACTIVE"
  | "MATRICULE_TAKEN"
  | "RUN_NOT_FOUND"
  | "RUN_EXISTS"
  | "RUN_STATUS"
  | "RUN_EMPTY"
  | "PAYSLIP_NOT_FOUND"
  | "DECLARATION_NOT_FOUND"
  | "PACK_NOT_FOUND"
  | "SCHEME_INCOMPLETE"
  | "RULE_ERROR"
  | "NET_MISMATCH"
  | "INVALID_INPUT";

/** Erreur métier du module paie ; l'API la traduit en 400/404/409/422. */
export class PayrollError extends Error {
  override name = "PayrollError";
  constructor(
    readonly code: PayrollErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** Statut HTTP conseillé. */
  get status(): 400 | 404 | 409 | 422 {
    switch (this.code) {
      case "EMPLOYEE_NOT_FOUND":
      case "RUN_NOT_FOUND":
      case "PAYSLIP_NOT_FOUND":
      case "DECLARATION_NOT_FOUND":
        return 404;
      case "RUN_EXISTS":
      case "RUN_STATUS":
      case "MATRICULE_TAKEN":
        return 409;
      case "INVALID_INPUT":
        return 400;
      default:
        return 422;
    }
  }
}
