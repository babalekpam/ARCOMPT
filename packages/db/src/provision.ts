// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Db } from "./client.js";

/**
 * Création du rôle de connexion applicatif.
 *
 * Le schéma définit un rôle de groupe `arcompt_app` : NOLOGIN, non propriétaire
 * des tables, soumis à la Row-Level Security, privé de DELETE sur les clés de
 * paie et de UPDATE/DELETE sur les journaux d'audit. Tant que l'API se connecte
 * avec le propriétaire du schéma, ce modèle ne protège rien : le propriétaire
 * contourne la RLS (les tables sont en FORCE ROW LEVEL SECURITY, mais il peut
 * la désactiver) et détient tous les droits.
 *
 * Un rôle de connexion suppose un mot de passe : il ne peut donc pas vivre dans
 * une migration versionnée. D'où ce module, appelé une fois par base par
 * `scripts/provision-app-role.ts`, avec le mot de passe lu dans
 * l'environnement.
 *
 * Idempotent : relancé, il remet les attributs en place, réaffirme
 * l'appartenance au groupe et fixe le mot de passe fourni — c'est aussi la
 * procédure de rotation.
 */

/** Rôle de groupe créé par la migration 0001 et affiné par 0010. */
export const APP_GROUP_ROLE = "arcompt_app";
export const QUEUE_GROUP_ROLE = "arcompt_queue";

/** Rôle de connexion par défaut ; même nom que celui du harnais de test. */
export const DEFAULT_APP_LOGIN = "arcompt_app_login";
export const DEFAULT_QUEUE_LOGIN = "arcompt_queue_login";

/** Un mot de passe de service n'est jamais tapé à la main : autant l'exiger long. */
export const MIN_PASSWORD_LENGTH = 16;

/** Mots de passe manifestement de démonstration : refusés d'emblée. */
const FORBIDDEN_PASSWORDS = ["arcompt", "arcompt_app", "postgres", "password", "changeme"];

const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export class ProvisionError extends Error {
  override name = "ProvisionError";
}

export interface ProvisionAppRoleInput {
  /** Nom du rôle de connexion ; minuscules, chiffres et `_` uniquement. */
  login?: string;
  /** Mot de passe, lu dans l'environnement par l'appelant. Jamais journalisé. */
  password: string;
}

export interface RoleAttributes {
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  createDb: boolean;
  inherit: boolean;
}

export interface ProvisionAppRoleResult {
  login: string;
  database: string;
  /** Vrai si le rôle vient d'être créé ; faux s'il existait (mot de passe remis à la valeur fournie). */
  created: boolean;
  memberOf: string;
  attributes: RoleAttributes;
  /** Contrôle du modèle de droits effectivement obtenu. */
  privileges: PrivilegeVerification;
}

/** Un droit attendu (ou refusé) sur une table, tel que le décrit le schéma. */
export interface ExpectedPrivilege {
  table: string;
  privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "REFERENCES" | "TRIGGER";
  /** Vrai : le rôle applicatif doit l'avoir. Faux : il ne doit pas l'avoir. */
  granted: boolean;
  why: string;
}

export interface PrivilegeObservation extends ExpectedPrivilege {
  actual: boolean | null; // null : table absente de cette base
  ok: boolean;
}

export interface PrivilegeVerification {
  ok: boolean;
  observations: PrivilegeObservation[];
  violations: PrivilegeObservation[];
}

/**
 * Modèle de droits du rôle applicatif, en un seul endroit.
 *
 * Deux familles s'y mélangent volontairement :
 *  - ce que l'application doit pouvoir faire (sinon l'API tombe en
 *    « permission denied » en production) ;
 *  - ce qu'elle ne doit surtout pas pouvoir faire, y compris quand un bug ou
 *    une injection SQL lui fait exécuter n'importe quoi.
 *
 * `journal_entry` et `journal_line` gardent UPDATE et DELETE au niveau table :
 * l'application modifie et supprime des BROUILLONS. L'inaltérabilité d'une
 * écriture validée est tenue par les triggers `journal_entry_immutable` et
 * `journal_line_immutable`, pas par les droits SQL — les retirer casserait la
 * saisie sans rien ajouter.
 */
export const EXPECTED_APP_PRIVILEGES: readonly ExpectedPrivilege[] = [
  { table: "journal_entry", privilege: "SELECT", granted: true, why: "lecture du grand livre" },
  { table: "journal_entry", privilege: "INSERT", granted: true, why: "saisie d'écritures" },
  { table: "journal_entry", privilege: "UPDATE", granted: true, why: "brouillon → validée (l'inaltérabilité est tenue par trigger)" },
  { table: "journal_entry", privilege: "DELETE", granted: true, why: "suppression d'un brouillon (refusée sur une écriture validée par trigger)" },
  { table: "journal_line", privilege: "DELETE", granted: true, why: "lignes d'un brouillon" },
  { table: "account_balance", privilege: "SELECT", granted: true, why: "balance et états financiers" },
  { table: "account_balance", privilege: "INSERT", granted: false, why: "soldes tenus par le trigger SECURITY DEFINER, jamais par l'application" },
  { table: "account_balance", privilege: "UPDATE", granted: false, why: "idem" },
  { table: "account_balance", privilege: "DELETE", granted: false, why: "idem" },
  { table: "audit_log", privilege: "INSERT", granted: true, why: "piste d'audit alimentée par l'application" },
  { table: "audit_log", privilege: "UPDATE", granted: false, why: "piste d'audit en insertion seule" },
  { table: "audit_log", privilege: "DELETE", granted: false, why: "piste d'audit en insertion seule" },
  { table: "ai_call_log", privilege: "UPDATE", granted: false, why: "journal des appels IA en insertion seule" },
  { table: "ai_call_log", privilege: "DELETE", granted: false, why: "journal des appels IA en insertion seule" },
  { table: "payroll_tenant_key", privilege: "SELECT", granted: true, why: "déchiffrement des champs de paie" },
  { table: "payroll_tenant_key", privilege: "INSERT", granted: true, why: "création d'une version de clé" },
  { table: "payroll_tenant_key", privilege: "UPDATE", granted: true, why: "retraite d'une version lors de la rotation" },
  { table: "payroll_tenant_key", privilege: "DELETE", granted: false, why: "supprimer la clé rendrait la paie du dossier définitivement indéchiffrable" },
  { table: "admin_access_log", privilege: "INSERT", granted: true, why: "tout accès administrateur est journalisé" },
  { table: "admin_access_log", privilege: "DELETE", granted: false, why: "journal d'accès administrateur en insertion seule" },
  { table: "whatsapp_webhook_receipt", privilege: "INSERT", granted: true, why: "anti-rejeu : marquer un message traité" },
  { table: "whatsapp_webhook_receipt", privilege: "UPDATE", granted: false, why: "réécrire un accusé permettrait de rejouer un message" },
  { table: "subscription_plan", privilege: "SELECT", granted: true, why: "catalogue d'abonnements lu par le portail" },
  { table: "subscription_plan", privilege: "INSERT", granted: false, why: "catalogue en lecture seule pour l'application" },
  { table: "subscription_plan", privilege: "UPDATE", granted: false, why: "catalogue en lecture seule pour l'application" },
  { table: "subscription_plan", privilege: "DELETE", granted: false, why: "catalogue en lecture seule pour l'application" },
  ...["app_mfa_factor", "app_mfa_proof"].flatMap((table) =>
    (["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const).map((privilege) =>
      ({ table, privilege, granted: false, why: "facteurs MFA : fonctions sécurisées exclusivement" }))),
  { table: "schema_migration", privilege: "SELECT", granted: false, why: "historique des migrations : affaire du compte de migration" },
  { table: "schema_migration", privilege: "INSERT", granted: false, why: "idem" },
  { table: "schema_migration", privilege: "UPDATE", granted: false, why: "idem" },
  { table: "schema_migration", privilege: "DELETE", granted: false, why: "idem" },
];

/** Valide un nom de rôle avant toute interpolation dans du DDL. */
export function assertValidRoleName(name: string): string {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new ProvisionError(`Nom de rôle invalide : « ${name} » (attendu : minuscules, chiffres et « _ », 63 caractères au plus)`);
  }
  return name;
}

/** Refuse les mots de passe trop courts ou manifestement de démonstration. */
export function assertUsablePassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ProvisionError(`Mot de passe trop court : ${MIN_PASSWORD_LENGTH} caractères au minimum`);
  }
  if (password.trim() !== password) {
    throw new ProvisionError("Mot de passe encadré d'espaces : très probablement une erreur de copie");
  }
  if (FORBIDDEN_PASSWORDS.includes(password.toLowerCase())) {
    throw new ProvisionError("Mot de passe de démonstration refusé");
  }
  return password;
}

/**
 * Construit une commande DDL côté serveur avec `format()` : l'identifiant passe
 * par %I et le mot de passe par %L, donc aucune concaténation de chaîne en
 * JavaScript, aucune injection possible par un mot de passe contenant une
 * apostrophe.
 */
async function ddl(db: Db, template: string, args: readonly string[]): Promise<void> {
  const rows = await db`SELECT format(${template}, VARIADIC ${db.array([...args])}::text[]) AS stmt`;
  await db.unsafe(rows[0]!.stmt as string);
}

/** Attributs de rôle : refusés à un compte non superutilisateur sur certains hébergeurs. */
const ROLE_ATTRIBUTES = "LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS";

function isInsufficientPrivilege(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "42501";
}

async function readAttributes(db: Db, login: string): Promise<RoleAttributes> {
  const [row] = await db`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit FROM pg_roles WHERE rolname = ${login}`;
  if (!row) throw new ProvisionError(`Rôle ${login} introuvable après création`);
  return {
    superuser: row.rolsuper as boolean,
    bypassRls: row.rolbypassrls as boolean,
    createRole: row.rolcreaterole as boolean,
    createDb: row.rolcreatedb as boolean,
    inherit: row.rolinherit as boolean,
  };
}

/** Crée (ou remet en conformité) le rôle de connexion membre de `arcompt_app`. */
export async function provisionAppRole(db: Db, input: ProvisionAppRoleInput): Promise<ProvisionAppRoleResult> {
  const login = assertValidRoleName(input.login ?? DEFAULT_APP_LOGIN);
  const password = assertUsablePassword(input.password);
  if (login === APP_GROUP_ROLE) {
    throw new ProvisionError(`Le rôle de groupe ${APP_GROUP_ROLE} doit rester NOLOGIN : choisissez un autre nom (par défaut ${DEFAULT_APP_LOGIN})`);
  }

  const group = await db`SELECT 1 FROM pg_roles WHERE rolname = ${APP_GROUP_ROLE}`;
  if (group.length === 0) {
    throw new ProvisionError(`Rôle ${APP_GROUP_ROLE} absent : appliquez les migrations avant de provisionner (pnpm db:migrate)`);
  }

  const existing = await db`SELECT 1 FROM pg_roles WHERE rolname = ${login}`;
  const created = existing.length === 0;
  const verb = created ? "CREATE ROLE %I " : "ALTER ROLE %I WITH ";
  try {
    await ddl(db, `${verb}${ROLE_ATTRIBUTES} PASSWORD %L`, [login, password]);
  } catch (e) {
    // Certains hébergeurs (Neon, RDS) réservent la pose explicite de
    // NOSUPERUSER / NOBYPASSRLS au superutilisateur : on retombe sur la forme
    // minimale, puis on vérifie le résultat plutôt que de le supposer.
    if (!isInsufficientPrivilege(e)) throw e;
    await ddl(db, `${verb}LOGIN INHERIT PASSWORD %L`, [login, password]);
  }
  // Appartenance et connexion : idempotentes, réexécutées à chaque passage.
  await ddl(db, "GRANT %I TO %I", [APP_GROUP_ROLE, login]);
  const [dbName] = await db`SELECT current_database() AS name`;
  await ddl(db, "GRANT CONNECT ON DATABASE %I TO %I", [dbName!.name as string, login]);

  const attributes = await readAttributes(db, login);
  if (attributes.superuser || attributes.bypassRls) {
    throw new ProvisionError(
      `Le rôle ${login} contourne la Row-Level Security (superuser=${attributes.superuser}, bypassrls=${attributes.bypassRls}) : retirez ces attributs avant de l'utiliser pour l'application`,
    );
  }
  if (!attributes.inherit) {
    throw new ProvisionError(`Le rôle ${login} est NOINHERIT : il n'hériterait pas des droits de ${APP_GROUP_ROLE}`);
  }

  return {
    login,
    database: dbName!.name as string,
    created,
    memberOf: APP_GROUP_ROLE,
    attributes,
    privileges: await verifyAppPrivileges(db, login),
  };
}

/** Provision only the login which may invoke cross-tenant queue functions. */
export async function provisionQueueRole(db: Db, input: ProvisionAppRoleInput): Promise<ProvisionAppRoleResult> {
  const login = assertValidRoleName(input.login ?? DEFAULT_QUEUE_LOGIN);
  const password = assertUsablePassword(input.password);
  const reserved = new Set([QUEUE_GROUP_ROLE, APP_GROUP_ROLE, DEFAULT_APP_LOGIN, "neondb_owner", "postgres", "current_user"]);
  if (reserved.has(login)) throw new ProvisionError(`Nom de rôle réservé : ${login}`);
  const group = await db`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    FROM pg_roles WHERE rolname = ${QUEUE_GROUP_ROLE}`;
  if (!group.length) throw new ProvisionError(`Rôle ${QUEUE_GROUP_ROLE} absent : appliquez les migrations avant de provisionner`);
  if (group[0]!.rolsuper || group[0]!.rolbypassrls || group[0]!.rolcreaterole || group[0]!.rolcreatedb)
    throw new ProvisionError(`Le groupe ${QUEUE_GROUP_ROLE} possède des attributs privilégiés`);
  const existing = await db`SELECT 1 FROM pg_roles WHERE rolname = ${login}`;
  const created = existing.length === 0;
  if (!created) {
    const [safety] = await db`
      SELECT
        EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member
          JOIN pg_roles granted_role ON granted_role.oid = m.roleid
          WHERE member.rolname = ${login} AND granted_role.rolname = ${QUEUE_GROUP_ROLE}) AS queue_member,
        EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member
          JOIN pg_roles granted_role ON granted_role.oid = m.roleid
          WHERE member.rolname = ${login} AND granted_role.rolname <> ${QUEUE_GROUP_ROLE}) AS other_membership,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles owner ON owner.oid = c.relowner
          WHERE owner.rolname = ${login}) AS owns_objects`;
    if (!safety?.queue_member)
      throw new ProvisionError(`Le rôle existant ${login} n'est pas déjà membre de ${QUEUE_GROUP_ROLE} : aucune rotation effectuée`);
    if (safety.other_membership)
      throw new ProvisionError(`Le rôle existant ${login} possède d'autres appartenances : aucune rotation effectuée`);
    if (safety.owns_objects)
      throw new ProvisionError(`Le rôle existant ${login} possède des objets : aucune rotation effectuée`);
  }
  const verb = created ? "CREATE ROLE %I " : "ALTER ROLE %I WITH ";
  try {
    await ddl(db, `${verb}${ROLE_ATTRIBUTES} PASSWORD %L`, [login, password]);
  } catch (e) {
    if (!isInsufficientPrivilege(e)) throw e;
    await ddl(db, `${verb}LOGIN INHERIT PASSWORD %L`, [login, password]);
  }
  // A rotated/reused login must never retain the tenant-data role.
  await ddl(db, "REVOKE %I FROM %I", [APP_GROUP_ROLE, login]);
  await ddl(db, "GRANT %I TO %I", [QUEUE_GROUP_ROLE, login]);
  const [dbName] = await db`SELECT current_database() AS name`;
  await ddl(db, "GRANT CONNECT ON DATABASE %I TO %I", [dbName!.name as string, login]);
  const attributes = await readAttributes(db, login);
  if (attributes.superuser || attributes.bypassRls || attributes.createRole || attributes.createDb || !attributes.inherit)
    throw new ProvisionError(`Le rôle ${login} possède des attributs privilégiés ou NOINHERIT`);
  const rows = await db`
    SELECT has_table_privilege(${login}, 'public.background_job', p.privilege) AS granted,
           p.privilege
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']::text[]) AS p(privilege)`;
  const observations = rows.map((row) => ({
    table: "background_job", privilege: row.privilege as ExpectedPrivilege["privilege"],
    granted: false, actual: row.granted as boolean,
    ok: !(row.granted as boolean), why: "le rôle de file ne lit ni ne modifie les lignes directement",
  }));
  const [membership] = await db`
    SELECT EXISTS (
      SELECT 1 FROM pg_auth_members m
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles granted_role ON granted_role.oid = m.roleid
      WHERE member.rolname = ${login}
        AND (granted_role.rolname = 'arcompt_app'
          OR granted_role.rolsuper OR granted_role.rolbypassrls
          OR granted_role.rolcreaterole OR granted_role.rolcreatedb)
    ) AS privileged_membership`;
  if (membership?.privileged_membership) throw new ProvisionError(`Le rôle ${login} hérite d'un groupe privilégié`);
  const violations = observations.filter((o) => !o.ok);
  return { login, database: dbName!.name as string, created, memberOf: QUEUE_GROUP_ROLE, attributes,
    privileges: { ok: violations.length === 0, observations, violations } };
}

/**
 * Confronte les droits réels d'un rôle au modèle déclaré ci-dessus.
 *
 * Interroger le rôle de connexion plutôt que le groupe est volontaire :
 * `has_table_privilege` suit l'appartenance, donc ce contrôle prouve ce que
 * l'API pourra réellement faire une fois connectée.
 */
export async function verifyAppPrivileges(db: Db, role: string = APP_GROUP_ROLE): Promise<PrivilegeVerification> {
  assertValidRoleName(role);
  const exists = await db`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
  if (exists.length === 0) throw new ProvisionError(`Rôle inconnu : ${role}`);

  const tables = EXPECTED_APP_PRIVILEGES.map((e) => e.table);
  const privileges = EXPECTED_APP_PRIVILEGES.map((e) => e.privilege);
  const rows = await db`
    SELECT t.ord,
           CASE WHEN to_regclass('public.' || quote_ident(t.tbl)) IS NULL THEN NULL
                ELSE has_table_privilege(${role}, quote_ident(t.tbl), t.priv) END AS granted
      FROM unnest(${db.array([...tables])}::text[], ${db.array([...privileges])}::text[])
        WITH ORDINALITY AS t(tbl, priv, ord)`;

  const actualByOrd = new Map(rows.map((r) => [Number(r.ord), r.granted as boolean | null]));
  const observations: PrivilegeObservation[] = EXPECTED_APP_PRIVILEGES.map((expected, i) => {
    const actual = actualByOrd.get(i + 1) ?? null;
    // Table absente (base plus ancienne) : on ne conclut pas à une violation.
    return { ...expected, actual, ok: actual === null || actual === expected.granted };
  });
  const violations = observations.filter((o) => !o.ok);
  return { ok: violations.length === 0, observations, violations };
}

/** Rend une violation lisible dans un terminal ou un message d'erreur. */
export function describeViolation(v: PrivilegeObservation): string {
  return v.granted
    ? `${v.table}: ${v.privilege} manquant (${v.why})`
    : `${v.table}: ${v.privilege} accordé alors qu'il doit être refusé (${v.why})`;
}
