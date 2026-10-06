export interface AdminModeStatus {
  eligible: boolean;
  approvedPending?: boolean;
  active: boolean;
  expiresAt: string | null;
  canReturn?: boolean;
}

export function adminModeLabel(mode: AdminModeStatus): string {
  if (mode.active) return "Mode super-admin actif";
  if (mode.canReturn) return "Mode super-admin expiré ou révoqué";
  if (mode.approvedPending) return "Activation administrateur approuvée";
  if (mode.eligible) return "Accès super-admin disponible";
  return "Compte utilisateur · accès super-admin non autorisé";
}

/** Only a fixed, local continuation is accepted. It is intent, never authority. */
export function isAdminActivationContinuation(pathname: string, search: string): boolean {
  return pathname === "/account/security" && new URLSearchParams(search).get("admin") === "activate";
}

export const ADMIN_MFA_CONTINUATION = "/account/security?admin=activate";
