import type { Sql } from "postgres";

/** The queue connection is deliberately separate from tenant-data access. */
export function queueDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV !== "production") return env.QUEUE_DATABASE_URL?.trim() || undefined;
  const url = env.QUEUE_DATABASE_URL?.trim();
  if (!url) throw new Error("QUEUE_DATABASE_URL absent : le rôle de file dédié est obligatoire en production");
  return url;
}


export function assertDistinctDatabaseUrls(appUrl: string | undefined, queueUrl: string | undefined): void {
  if (appUrl && queueUrl && appUrl === queueUrl)
    throw new Error("APP_DATABASE_URL et QUEUE_DATABASE_URL doivent pointer vers des connexions distinctes");
}

/** Read-only startup check for the dedicated PostgreSQL queue login. */
export async function assertProductionQueueDatabaseSecurity(queueDb: Sql, appDb: Sql): Promise<void> {
  const [check] = await queueDb`SELECT
    r.rolname AS role, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolinherit,
    has_function_privilege(current_user, to_regprocedure('background_job_claim(text[])'), 'EXECUTE') AS claim,
    has_function_privilege(current_user, to_regprocedure('background_job_finish(uuid,uuid,text)'), 'EXECUTE') AS finish,
    has_function_privilege(current_user, to_regprocedure('background_job_renew(uuid,uuid)'), 'EXECUTE') AS renew,
    has_function_privilege(current_user, to_regprocedure('background_job_expire_reminders()'), 'EXECUTE') AS expire,
    has_table_privilege(current_user, 'public.background_job', 'SELECT') AS can_select,
    has_table_privilege(current_user, 'public.background_job', 'INSERT') AS can_insert,
    has_table_privilege(current_user, 'public.background_job', 'UPDATE') AS can_update,
    has_table_privilege(current_user, 'public.background_job', 'DELETE') AS can_delete,
    has_table_privilege(current_user, 'public.background_job', 'TRUNCATE') AS can_truncate,
    has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
    (SELECT count(*) = 4 AND count(DISTINCT owner.rolname) = 1
       AND bool_and(p.prosecdef)
       AND bool_and(p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
       AND bool_and(owner.rolname NOT IN (current_user, 'arcompt_app', 'arcompt_queue'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE n.nspname = 'public' AND p.oid IN (
       to_regprocedure('public.background_job_claim(text[])'),
       to_regprocedure('public.background_job_renew(uuid,uuid)'),
       to_regprocedure('public.background_job_finish(uuid,uuid,text)'),
       to_regprocedure('public.background_job_expire_reminders()')
     )) AS functions_hardened,
    NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles group_role ON group_role.oid = m.roleid
      WHERE member.rolname = current_user AND group_role.rolname = 'arcompt_app'
    ) AS no_app_membership
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (!check || check.rolsuper || check.rolbypassrls || check.rolcreaterole || check.rolcreatedb || !check.rolinherit ||
    check.can_select || check.can_insert || check.can_update || check.can_delete || check.can_truncate ||
    !check.schema_usage || !check.functions_hardened || !check.no_app_membership ||
    !check.claim || !check.finish || !check.renew || !check.expire)
    throw new Error("Droits du rôle de file PostgreSQL non conformes : démarrage refusé");

  const [appCheck] = await appDb`SELECT current_user AS role,
    has_function_privilege(current_user, to_regprocedure('background_job_claim(text[])'), 'EXECUTE') AS claim,
    has_function_privilege(current_user, to_regprocedure('background_job_finish(uuid,uuid,text)'), 'EXECUTE') AS finish,
    has_function_privilege(current_user, to_regprocedure('background_job_renew(uuid,uuid)'), 'EXECUTE') AS renew,
    has_function_privilege(current_user, to_regprocedure('background_job_expire_reminders()'), 'EXECUTE') AS expire`;
  if (appCheck?.role === check.role)
    throw new Error("APP_DATABASE_URL et QUEUE_DATABASE_URL utilisent le même rôle PostgreSQL");
  if (appCheck?.claim || appCheck?.finish || appCheck?.renew || appCheck?.expire)
    throw new Error("Le rôle applicatif conserve EXECUTE sur les fonctions cross-tenant de la file");
}