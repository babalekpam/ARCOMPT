import { apiTry } from "./api";

export interface PlatformMe {
  platformAdmin: boolean;
}

/** Server-verified privilege. A browser claim is never used for this decision. */
export async function getPlatformAdmin(): Promise<boolean> {
  const result = await apiTry<PlatformMe>("/platform/me");
  return result.ok && result.data.platformAdmin === true;
}