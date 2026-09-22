import type { Sql } from "postgres";

/**
 * Résolution d'identité : Keycloak authentifie, ARCOMPT autorise.
 *
 * Le jeton ne porte plus que le `sub` ; les droits (organisation, dossiers,
 * rôles) sont lus dans la base via auth_resolve_identity() (migration 0009),
 * une fonction SECURITY DEFINER car `app_user` et `company_member` sont en
 * FORCE ROW LEVEL SECURITY et qu'aucun contexte tenant n'existe encore à cet
 * instant — c'est précisément ce que l'on cherche à établir.
 */
export interface Membership {
  companyId: string;
  role: string;
}

export interface Identity {
  /** `app_user.id` (uuid), et non le `sub` Keycloak : c'est lui qui alimente audit_log.user_id. */
  userId: string;
  organizationId: string;
  /** Non nul si le compte est suspendu (inactivité, décision du cabinet). */
  suspendedAt: Date | null;
  /** `organization.mfa_required` : l'API refuse alors un jeton sans second facteur. */
  mfaRequired: boolean;
  memberships: Membership[];
}

/**
 * Indications tirées du jeton, utilisées seulement pour le rattachement au
 * premier accès. `emailVerified` est décisif : sans lui, s'inscrire avec
 * l'adresse d'autrui suffirait à prendre son compte.
 */
export interface TokenIdentityHints {
  email?: string;
  emailVerified?: boolean;
}

/**
 * Résout un `sub` Keycloak en identité ARCOMPT ; null si le sujet est inconnu.
 *
 * Un compte créé par le portail (invitation) ou par le seed n'a pas encore de
 * `keycloak_sub`. Plutôt que d'exiger un UPDATE manuel par utilisateur avant de
 * pouvoir se connecter, on le rattache au premier accès, sur une adresse de
 * courriel vérifiée et sans jamais réécrire un rattachement existant.
 */
export async function resolveIdentity(db: Sql, sub: string, hints: TokenIdentityHints = {}): Promise<Identity | null> {
  const found = await selectIdentity(db, sub);
  if (found) return found;
  if (!hints.emailVerified || !hints.email) return null;
  const linked = await linkSubject(db, sub, hints.email);
  if (!linked) return null;
  return selectIdentity(db, sub);
}

/**
 * Rattache un `sub` au compte portant cette adresse, si et seulement si ce
 * compte n'est rattaché à personne et que l'adresse ne désigne qu'un compte.
 * Renvoie l'identifiant rattaché, ou null si rien n'a été fait.
 */
export async function linkSubject(db: Sql, sub: string, email: string): Promise<string | null> {
  const [row] = await db`SELECT auth_link_subject(${sub}, ${email}) AS user_id`;
  const id = row?.user_id;
  return id == null ? null : String(id);
}

async function selectIdentity(db: Sql, sub: string): Promise<Identity | null> {
  const rows = await db`SELECT user_id, organization_id, suspended_at, mfa_required, company_id, role FROM auth_resolve_identity(${sub})`;
  const head = rows[0];
  if (!head) return null;
  return {
    userId: String(head.user_id),
    organizationId: String(head.organization_id),
    suspendedAt: toDate(head.suspended_at),
    mfaRequired: head.mfa_required === true,
    memberships: rows.filter((r) => r.company_id != null).map((r) => ({ companyId: String(r.company_id), role: String(r.role) })),
  };
}

/**
 * Marque l'activité de l'utilisateur. Au mieux : une écriture ratée (base
 * indisponible, verrou) ne doit jamais faire échouer la requête métier, mais
 * sans elle `last_active_at` reste NULL et suspendInactiveAccounts() ne se
 * fonde que sur la date de création du compte.
 */
export async function touchLastActive(db: Sql, userId: string): Promise<void> {
  try {
    await db`SELECT auth_touch_last_active(${userId})`;
  } catch {
    // ignoré volontairement
  }
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return null;
}
