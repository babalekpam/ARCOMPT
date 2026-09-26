// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { describeViolation, verifyAppPrivileges } from "@arcompt/db";

const REQUIRED_TABLES = ["onboarding_bootstrap", "platform_admin", "platform_admin_audit", "background_job", "background_job_review", "app_mfa_factor", "app_mfa_proof", "platform_admin_binding", "platform_admin_mode"] as const;
const REQUIRED_POLICIES = [
  ["platform_admin_binding", "platform_admin_binding_internal"],
  ["platform_admin_mode", "platform_admin_mode_internal"],
  ["app_mfa_factor", "app_mfa_factor_internal"],
  ["app_mfa_proof", "app_mfa_proof_internal"],
  ["onboarding_bootstrap", "onboarding_bootstrap_access"],
  ["platform_admin", "platform_admin_internal"],
  ["platform_admin_audit", "platform_admin_audit_internal"],
  ["background_job", "tenant_isolation"],
  ["background_job", "background_job_owner"],
  ["background_job_review", "tenant_isolation"],
  ["background_job_review", "background_job_review_owner"],
] as const;
const REQUIRED_FUNCTIONS = [
  "public.platform_mode_eligible(text)",
  "public.platform_mode_identity(text,text,text,text)",
  "public.platform_mode_activate(text,text,text,text)",
  "public.platform_mode_deactivate(text,text,text)",
  "public.platform_mode_companies(text,text,text,text)",
  "public.platform_mode_record_access(text,text,text,text,uuid,text,text)",
  "public.app_mfa_attempt(text)",
  "public.app_mfa_enroll(text,text)",
  "public.app_mfa_lock(text)",
  "public.app_mfa_status(text,text,text)",
  "public.app_mfa_complete(text,text,text,bigint,text,text,text[],text)",
  "public.auth_bootstrap_lookup(text,text)",
  "public.auth_bootstrap_replay(text)",
  "public.platform_admin_identity(text)",
  "public.platform_admin_company(text,uuid)",
  "public.platform_admin_companies(text)",
  "public.platform_admin_record_access(text,uuid,text,text)",
  "public.background_job_retry_internal(uuid)",
  "public.background_job_review_reminder(uuid,uuid,text)",
  "public.background_job_claim(text[])",
  "public.background_job_renew(uuid,uuid)",
  "public.background_job_finish(uuid,uuid,text)",
  "public.background_job_expire_reminders()",
  "public.auth_resolve_identity(text)",
  "public.auth_link_subject(text,text)",
  "public.auth_touch_last_active(uuid)",
  "public.organization_of_company(uuid)",
  "public.portal_dashboard(uuid)",
  "public.invitation_by_token_hash(text)",
  "public.whatsapp_resolve_phone(text)",
  "public.payment_link_resolve(text,text)",
] as const;
const QUEUE_FUNCTIONS = new Set([
  "public.background_job_claim(text[])",
  "public.background_job_renew(uuid,uuid)",
  "public.background_job_finish(uuid,uuid,text)",
  "public.background_job_expire_reminders()",
]);

function normalized(expression: string | null): string {
  return (expression ?? "").replace(/\s+/g, " ").trim();
}

function requiredPolicyExpression(table: string, name: string): string {
  if (name === "tenant_isolation") return "(tenant_id = app_tenant_id())";
  if (table === "onboarding_bootstrap") {
    return "(clerk_sub = current_setting('app.clerk_sub'::text, true))";
  }
  // Compare PostgreSQL's normalized policy expression, not just the policy
  // name: a permissive USING (true) must never count as a safe Publish.
  return `(CURRENT_USER = ( SELECT r.rolname FROM (pg_class c JOIN pg_roles r ON ((r.oid = c.relowner))) WHERE (c.oid = ('${table}'::regclass)::oid)))`;
}

type RoleRow = { name: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole?: boolean; rolcreatedb?: boolean };
type TableRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owned_by_app: boolean };
type PolicyRow = { tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null };
type FunctionRow = {
  signature: string;
  exists: boolean;
  security_definer: boolean | null;
  executable: boolean | null;
  owner: string | null;
  managed_owner: string | null;
  proconfig: string[] | null;
  public_execute: boolean | null;
  app_execute: boolean | null;
  queue_execute: boolean | null;
};

export type DatabaseSecuritySnapshot = {
  role: RoleRow;
  tables: TableRow[];
  policies: PolicyRow[];
  functions: FunctionRow[];
};

/** A read-only, fail-closed check of the database properties this API relies on. */
export function databaseSecurityProblems(snapshot: DatabaseSecuritySnapshot): string[] {
  const problems: string[] = [];
  if (snapshot.role.rolsuper || snapshot.role.rolbypassrls || snapshot.role.rolcreaterole || snapshot.role.rolcreatedb) {
    problems.push("le rôle applicatif contourne les politiques RLS");
  }

  const tables = new Map(snapshot.tables.map((table) => [table.relname, table]));
  for (const name of REQUIRED_TABLES) {
    if (!tables.has(name)) problems.push(`table ${name} absente`);
  }
  for (const table of snapshot.tables) {
    if (table.owned_by_app) problems.push(`le rôle applicatif possède la table ${table.relname} et peut modifier sa RLS`);
    if (!table.relrowsecurity || !table.relforcerowsecurity) {
      problems.push(`RLS non activée et forcée sur ${table.relname}`);
    }
    const policies = snapshot.policies.filter((policy) => policy.tablename === table.relname);
    if (!policies.length) problems.push(`aucune politique RLS sur ${table.relname}`);
    for (const policy of policies) {
      // The global subscription-plan catalogue is intentionally readable,
      // but never writable, by the app. Its SELECT-only policy cannot
      // authorize a write; verifyAppPrivileges checks the missing DML grants.
      const publicCatalogueRead = table.relname === "subscription_plan" &&
        policy.policyname === "subscription_plan_read" && policy.cmd === "SELECT" &&
        normalized(policy.qual) === "true" && policy.with_check === null;
      if (publicCatalogueRead) continue;
      if (!policy.qual && !policy.with_check) {
        problems.push(`politique RLS sans condition : ${table.relname}.${policy.policyname}`);
      } else if (["true", "(true)"].includes(normalized(policy.qual)) || ["true", "(true)"].includes(normalized(policy.with_check))) {
        problems.push(`politique RLS autorisant tout : ${table.relname}.${policy.policyname}`);
      }
    }
  }
  for (const [table, name] of REQUIRED_POLICIES) {
    const policy = snapshot.policies.find((row) => row.tablename === table && row.policyname === name);
    if (!policy || !policy.qual || !policy.with_check) {
      problems.push(`politique requise absente ou incomplète : ${table}.${name}`);
    } else if (normalized(policy.qual) !== requiredPolicyExpression(table, name) || normalized(policy.with_check) !== requiredPolicyExpression(table, name)) {
      problems.push(`politique requise différente de la règle de développement : ${table}.${name}`);
    }
  }
  for (const signature of REQUIRED_FUNCTIONS) {
    const fn = snapshot.functions.find((row) => row.signature === signature);
    if (!fn?.exists || !fn.security_definer ||
        !fn.owner || !fn.managed_owner || fn.owner !== fn.managed_owner ||
        JSON.stringify(fn.proconfig) !== JSON.stringify(["search_path=pg_catalog, public, pg_temp"]) ||
        fn.public_execute !== false ||
        (QUEUE_FUNCTIONS.has(signature) ? fn.executable !== false : fn.executable !== true) ||
        (QUEUE_FUNCTIONS.has(signature) ? fn.app_execute !== false : fn.app_execute !== true) ||
        (QUEUE_FUNCTIONS.has(signature) ? fn.queue_execute === false : fn.queue_execute === true)) {
      problems.push(`fonction sécurisée indisponible pour l'application : ${signature}`);
    }
  }
  return problems;
}

/** Called before opening the HTTP listener, not from a migration or publish hook. */
export async function assertProductionDatabaseSecurity(db: Sql): Promise<void> {
  const [roles, tables, policies, functions] = await Promise.all([
    db<RoleRow[]>`SELECT current_user AS name, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
      FROM pg_roles r WHERE r.rolname = current_user`,
    db<TableRow[]>`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned_by_app
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (c.relrowsecurity OR c.relname IN ('onboarding_bootstrap', 'platform_admin', 'platform_admin_audit', 'background_job', 'background_job_review')
          OR EXISTS (SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'))`,
    db<PolicyRow[]>`SELECT p.tablename, p.policyname, p.cmd, p.qual, p.with_check
      FROM pg_policies p WHERE p.schemaname = 'public'`,
      db<FunctionRow[]>`SELECT f.signature, p.oid IS NOT NULL AS exists, p.prosecdef AS security_definer,
        has_function_privilege(current_user, p.oid, 'EXECUTE') AS executable,
        pg_get_userbyid(p.proowner) AS owner,
        (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
          JOIN pg_namespace cn ON cn.oid = c.relnamespace
         WHERE cn.nspname = 'public' AND c.relname = 'app_user'
           AND c.relkind IN ('r', 'p')) AS managed_owner,
        p.proconfig,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
        has_function_privilege('arcompt_app', p.oid, 'EXECUTE') AS app_execute,
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles qr WHERE qr.rolname = 'arcompt_queue')
          THEN has_function_privilege('arcompt_queue', p.oid, 'EXECUTE') ELSE NULL END AS queue_execute
      FROM (VALUES
        ('public.platform_mode_eligible(text)'),
        ('public.platform_mode_identity(text,text,text,text)'),
        ('public.platform_mode_activate(text,text,text,text)'),
        ('public.platform_mode_deactivate(text,text,text)'),
        ('public.platform_mode_companies(text,text,text,text)'),
        ('public.platform_mode_record_access(text,text,text,text,uuid,text,text)'),
        ('public.app_mfa_attempt(text)'),
        ('public.app_mfa_enroll(text,text)'),
        ('public.app_mfa_lock(text)'),
        ('public.app_mfa_status(text,text,text)'),
        ('public.app_mfa_complete(text,text,text,bigint,text,text,text[],text)'),
        ('public.auth_bootstrap_lookup(text,text)'),
        ('public.auth_bootstrap_replay(text)'),
        ('public.platform_admin_identity(text)'),
        ('public.platform_admin_company(text,uuid)'),
        ('public.platform_admin_companies(text)'),
        ('public.platform_admin_record_access(text,uuid,text,text)'),
        ('public.background_job_retry_internal(uuid)'),
         ('public.background_job_review_reminder(uuid,uuid,text)'),
         ('public.background_job_claim(text[])'),
         ('public.background_job_renew(uuid,uuid)'),
         ('public.background_job_finish(uuid,uuid,text)'),
         ('public.background_job_expire_reminders()'),
         ('public.auth_resolve_identity(text)'),
         ('public.auth_link_subject(text,text)'),
         ('public.auth_touch_last_active(uuid)'),
         ('public.organization_of_company(uuid)'),
         ('public.portal_dashboard(uuid)'),
         ('public.invitation_by_token_hash(text)'),
         ('public.whatsapp_resolve_phone(text)'),
         ('public.payment_link_resolve(text,text)')
       ) AS f(signature)
       LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.signature)
      `,
  ]);
  if (!roles[0]) throw new Error("Sécurité de la base de production : rôle de connexion introuvable.");
  const problems = databaseSecurityProblems({
    role: roles[0],
    tables: [...tables],
    policies: [...policies],
    functions: [...functions],
  });
  if (problems.length) {
    throw new Error(`Sécurité de la base de production non conforme ; démarrage refusé :\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const privileges = await verifyAppPrivileges(db, roles[0].name);
  if (!privileges.ok) {
    throw new Error(`Droits du rôle applicatif non conformes ; démarrage refusé :\n${privileges.violations.map((v) => `  - ${describeViolation(v)}`).join("\n")}`);
  }
}