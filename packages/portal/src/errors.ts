// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
export type PortalErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INVITATION_INVALID"
  | "INVITATION_EXPIRED"
  | "INVITATION_ACCEPTED"
  | "LAST_OWNER"
  | "MFA_REQUIRED"
  | "MFA_REQUIRED_FOR_FIRM"
  | "PACK_UNAVAILABLE"
  | "FILING_STATE"
  | "PLAN_UPGRADE_REQUIRED"
  | "NOTIFY_FAILED";

/** Erreur métier du portail : l'API la traduit en 400/403/404/409/422. */
export class PortalError extends Error {
  override name = "PortalError";
  constructor(
    readonly code: PortalErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get httpStatus(): 400 | 403 | 404 | 409 | 422 | 502 {
    switch (this.code) {
      case "VALIDATION":
        return 400;
      case "FORBIDDEN":
      case "MFA_REQUIRED":
      case "PLAN_UPGRADE_REQUIRED":
        return 403;
      case "NOT_FOUND":
      case "INVITATION_INVALID":
        return 404;
      case "CONFLICT":
      case "INVITATION_ACCEPTED":
      case "LAST_OWNER":
      case "FILING_STATE":
        return 409;
      case "NOTIFY_FAILED":
        return 502;
      default:
        return 422;
    }
  }
}
