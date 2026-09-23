import { apiTry } from "./api";

export interface PlatformMe {
  platformAdmin: boolean;
}

/** A platform admin may work inside a selected company after the picker. */
export function shouldShowPlatformPicker(platformAdmin: boolean, tenantId: string | null): boolean {
  return platformAdmin && !tenantId;
}

/** Server-verified privilege. A browser claim is never used for this decision. */
export async function getPlatformAdmin(): Promise<boolean> {
  // An old tenant cookie must not prevent a platform admin from reaching the
  // global company picker (the API independently verifies the Clerk subject).
  const result = await apiTry<PlatformMe>("/platform/me", { headers: { "X-Tenant-Id": "" } });
  return result.ok && result.data.platformAdmin === true;
}