import { cache } from "react";
import { apiTry } from "./api";

/** A display label, not an authentication identifier. Scoped to this request. */
export const getCurrentMemberReference = cache(async (): Promise<string | null> => {
  const result = await apiTry<{ reference: string | null }>("/portal/org/members/self-reference");
  return result.ok ? result.data.reference : null;
});