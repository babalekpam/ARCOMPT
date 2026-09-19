/** Lectures serveur partagées du portail : rôle de l'utilisateur courant d'après ses appartenances. */
import { apiTry } from "@/lib/api";
import { resolveMyRole } from "./helpers";
import type { CompanyMember, MemberRole } from "./types";

export async function myRole(userId: string, tenantId: string | null): Promise<{ role: MemberRole | null; members: CompanyMember[] }> {
  const res = await apiTry<CompanyMember[]>("/portal/org/members");
  const members = res.ok && Array.isArray(res.data) ? res.data : [];
  return { role: resolveMyRole(members, userId, tenantId), members };
}
