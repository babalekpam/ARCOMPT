/**
 * Build the isolated private-publish repair review.  This is deliberately a
 * generator, rather than a migration: the output is a review artifact and
 * must never be run by application startup or a publish hook.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const out = resolve(root, "docs/PRIVATE-PUBLISH-REPAIR-REVIEW.md");
const fnSources = [
  "packages/db/migrations/0021_harden_onboarding_identity.sql",
  "packages/db/migrations/0028_security_definer_qualified.sql",
  "packages/db/migrations/0029_journal_balance_definer_qualified.sql",
];
const grantsPath = resolve(root, "docs/PRIVATE-PUBLISH-APP-GRANTS.sql");

function functionDefinitions(source: string): string[] {
  const starts = [...source.matchAll(/CREATE OR REPLACE FUNCTION\b/g)].map((m) => m.index!);
  return starts.map((start, i) => {
    const text = source.slice(start, i + 1 < starts.length ? starts[i + 1] : source.length);
    const end = text.indexOf("$$;", text.indexOf("AS $$"));
    if (end < 0) throw new Error("function definition has no AS $$ ... $$ terminator");
    return text.slice(0, end + 3).trim();
  });
}

function grantLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => /^GRANT /.test(line));
}

const [sources, grants] = await Promise.all([
  Promise.all(fnSources.map((file) => readFile(resolve(root, file), "utf8"))),
  readFile(grantsPath, "utf8"),
]);
const definitions = sources.flatMap(functionDefinitions);
if (definitions.length !== 21) throw new Error(`expected 21 function definitions, found ${definitions.length}`);
const expectedGrants = grantLines(grants.toString());
if (expectedGrants.length !== 278) throw new Error(`expected 278 ACL grants, found ${expectedGrants.length}`);

const signatures = [
  "auth_bootstrap_lookup(text,text)", "auth_bootstrap_replay(text)", "platform_admin_identity(text)",
  "platform_admin_company(text,uuid)", "platform_admin_companies(text)", "platform_admin_record_access(text,uuid,text,text)",
  "background_job_retry_internal(uuid)", "background_job_review_reminder(uuid,uuid,text)",
  "background_job_claim(text[])", "background_job_renew(uuid,uuid)", "background_job_finish(uuid,uuid,text)",
  "background_job_expire_reminders()", "auth_resolve_identity(text)", "auth_link_subject(text,text)",
  "auth_touch_last_active(uuid)", "organization_of_company(uuid)", "portal_dashboard(uuid)",
  "invitation_by_token_hash(text)", "whatsapp_resolve_phone(text)", "payment_link_resolve(text,text)",
];
const queueSignatures = new Set([
  "background_job_claim(text[])", "background_job_renew(uuid,uuid)",
  "background_job_finish(uuid,uuid,text)", "background_job_expire_reminders()",
]);
const expectedExecValues = signatures.map((s) =>
  `('public.${s}', ${queueSignatures.has(s) ? "false" : "true"}, ${queueSignatures.has(s) ? "true" : "false"})`).join(",\n    ");
const appFunctionGrants = signatures.filter((s) => !queueSignatures.has(s))
  .map((s) => `GRANT EXECUTE ON FUNCTION public.${s} TO arcompt_app;`).join("\n");

// These digests were independently compared against the read-only production
// catalog. They cover every existing table's constraints, indexes, triggers,
// PUBLIC ACL, RLS and policies except the explicitly repaired differences,
// plus every unchanged application function body.
const baselineChecks = String.raw`
  IF (SELECT count(*) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
        AND c.relkind IN ('r','p') AND c.relname NOT IN ('background_job','background_job_review')
        AND pg_get_userbyid(c.relowner)=current_user) <> 74 THEN
    RAISE EXCEPTION 'unexpected existing-table ownership or table count';
  END IF;
  IF (WITH obj AS (
    SELECT c.relname,
      md5(coalesce((SELECT string_agg(x.conname||':'||pg_get_constraintdef(x.oid),';' ORDER BY x.conname)
        FROM pg_constraint x WHERE x.conrelid=c.oid),'')) AS constraints,
      md5(coalesce((SELECT string_agg(i.relname||':'||pg_get_indexdef(i.oid),';' ORDER BY i.relname)
        FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=c.oid),'')) AS indexes,
      md5(coalesce((SELECT string_agg(t.tgname||':'||pg_get_triggerdef(t.oid),';' ORDER BY t.tgname)
        FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal
          AND t.tgname <> 'platform_admin_audit_immutable'),'')) AS triggers,
      md5(coalesce((SELECT string_agg(a.privilege_type||':'||a.is_grantable::text,',' ORDER BY a.privilege_type)
        FROM aclexplode(c.relacl) a WHERE a.grantee=0),'')) AS public_acl,
      CASE WHEN c.relname IN ('onboarding_bootstrap','platform_admin','platform_admin_audit')
        THEN 'EXPECTED_DIFF' ELSE (c.relrowsecurity::text||'/'||c.relforcerowsecurity::text) END AS rls,
      md5(coalesce((SELECT string_agg(p.policyname||':'||p.cmd||':'||coalesce(p.qual,'NULL')||':'||
          coalesce(p.with_check,'NULL'),';' ORDER BY p.policyname)
        FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname
          AND NOT (p.tablename||'.'||p.policyname IN
            ('onboarding_bootstrap.onboarding_bootstrap_access','platform_admin.platform_admin_internal',
             'platform_admin_audit.platform_admin_audit_internal'))),'')) AS policies
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('background_job','background_job_review')
  ) SELECT md5(string_agg(relname||'/'||constraints||'/'||indexes||'/'||triggers||'/'||
      public_acl||'/'||rls||'/'||policies,E'\n' ORDER BY relname)) FROM obj)
    IS DISTINCT FROM '8bdb263f407f16dc9dae692965a7d1f5' THEN
    RAISE EXCEPTION 'existing table constraints, triggers, RLS, policy or PUBLIC ACL drifted';
  END IF;
  IF (SELECT md5(string_agg(c.relname||'.'||a.attname||':'||
      format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||
      coalesce(pg_get_expr(def.adbin,def.adrelid),'NULL')||':'||
      coalesce((SELECT string_agg(acl.privilege_type||':'||acl.is_grantable::text,';'
        ORDER BY acl.privilege_type) FROM aclexplode(a.attacl) acl WHERE acl.grantee=0),''),
      E'\n' ORDER BY c.relname,a.attname))
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef def ON def.adrelid=c.oid AND def.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('background_job','background_job_review')
      AND NOT (c.relname='categorization_memory' AND a.attname='embedding'))
    IS DISTINCT FROM 'f7a27b5a178607a71a026b1dee435dc8' THEN
    RAISE EXCEPTION 'existing column definitions or PUBLIC column ACL drifted';
  END IF;
  IF (SELECT md5(string_agg(c.relname||':'||s.seqtypid::regtype::text||':'||
      s.seqstart||':'||s.seqincrement||':'||s.seqmin||':'||s.seqmax||':'||
      s.seqcache||':'||s.seqcycle||':'||
      coalesce((SELECT string_agg(a.privilege_type||':'||a.is_grantable::text,';'
        ORDER BY a.privilege_type) FROM aclexplode(c.relacl) a WHERE a.grantee=0),''),
      E'\n' ORDER BY c.relname))
    FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace)
    IS DISTINCT FROM '3933cba538ef40d5438a4cc916adb0fe' THEN
    RAISE EXCEPTION 'sequence definitions or PUBLIC grants drifted';
  END IF;
  IF (SELECT md5(string_agg(p.oid::regprocedure::text||':'||md5(pg_get_functiondef(p.oid)),
      E'\n' ORDER BY p.oid::regprocedure::text))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
        AND d.objid=p.oid AND d.deptype='e')
      AND p.proname <> ALL(ARRAY['auth_bootstrap_lookup','auth_bootstrap_replay',
        'platform_admin_identity','platform_admin_company','platform_admin_companies',
        'platform_admin_record_access','background_job_retry_internal','background_job_review_reminder',
        'background_job_claim','background_job_renew','background_job_finish',
        'background_job_expire_reminders','auth_resolve_identity','auth_link_subject',
        'auth_touch_last_active','organization_of_company','portal_dashboard',
        'invitation_by_token_hash','whatsapp_resolve_phone','payment_link_resolve',
        'journal_entry_update_balances']))
    IS DISTINCT FROM 'b9873e34ce57554c68a952e10b08317a' THEN
    RAISE EXCEPTION 'unchanged function bodies drifted (count=%)', (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
        AND d.objid=p.oid AND d.deptype='e')
      AND p.proname <> ALL(ARRAY['auth_bootstrap_lookup','auth_bootstrap_replay',
        'platform_admin_identity','platform_admin_company','platform_admin_companies',
        'platform_admin_record_access','background_job_retry_internal','background_job_review_reminder',
        'background_job_claim','background_job_renew','background_job_finish',
        'background_job_expire_reminders','auth_resolve_identity','auth_link_subject',
        'auth_touch_last_active','organization_of_company','portal_dashboard',
        'invitation_by_token_hash','whatsapp_resolve_phone','payment_link_resolve',
        'journal_entry_update_balances']));
  END IF;`;

const preflight = String.raw`-- PREFLIGHT: deliberately before every DDL statement.
DO $$
DECLARE relation_name text;
BEGIN
  IF current_user <> session_user OR current_user <> 'neondb_owner'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND
       NOT rolsuper AND rolbypassrls AND rolcreaterole) THEN
    RAISE EXCEPTION 'repair requires a direct neondb_owner session with the reviewed managed-owner attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('arcompt_app','arcompt_queue'))
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
                WHERE r.rolname=current_user AND m.roleid IN
                (SELECT oid FROM pg_roles WHERE rolname IN ('arcompt_app','arcompt_queue'))) THEN
    RAISE EXCEPTION 'app/queue roles or current-user memberships already exist; isolated rehearsal expected';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[
    'public.onboarding_bootstrap', 'public.platform_admin',
    'public.platform_admin_audit', 'public.company', 'public.app_user',
    'public.organization', 'public.platform_admin_reserved_org',
    'public.background_job', 'public.background_job_review'
  ] LOOP
    IF to_regclass(relation_name) IS NULL OR
      (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass(relation_name)) IS DISTINCT FROM current_user
    THEN RAISE EXCEPTION 'required table missing or unexpectedly owned: %', relation_name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN
      ('onboarding_bootstrap','platform_admin','platform_admin_audit')
      AND qual IS NULL AND with_check IS NULL) <> 3
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN
      ('background_job','background_job_review') AND qual IS NULL AND with_check IS NULL) <> 4 THEN
    RAISE EXCEPTION 'expected exactly 3+4 bare policies before repair';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname IN
      ('background_job','background_job_review') AND (NOT relrowsecurity OR relforcerowsecurity)) THEN
    RAISE EXCEPTION 'job tables must exist with RLS enabled and not forced before repair';
  END IF;
  IF (SELECT count(*) FROM (VALUES
    ('platform_admin_identity(text)'),('platform_admin_company(text,uuid)'),
    ('platform_admin_companies(text)'),('platform_admin_record_access(text,uuid,text,text)'),
    ('auth_bootstrap_lookup(text,text)'),('auth_bootstrap_replay(text)'),
    ('background_job_claim(text[])'),('background_job_renew(uuid,uuid)'),
    ('background_job_finish(uuid,uuid,text)'),('background_job_expire_reminders()'),
    ('background_job_retry_internal(uuid)'),('background_job_review_reminder(uuid,uuid,text)')
  ) AS x(signature) WHERE to_regprocedure(x.signature) IS NULL) <> 12 THEN
    RAISE EXCEPTION 'the observed twelve missing function names are not all missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='platform_admin_reserved_org' AND c.conname='platform_admin_reserved_org_pkey'
      AND pg_get_constraintdef(c.oid) LIKE '%singleton%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='platform_admin_reserved_org' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE '%organization%') THEN
    RAISE EXCEPTION 'reserved singleton constraint/dependency is missing';
  END IF;
  ${baselineChecks}
END $$;`;

const postExec = String.raw`DO $$
DECLARE bad integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('arcompt_app','arcompt_queue')
             AND (rolcanlogin OR rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'group roles must be NOLOGIN NOSUPERUSER NOBYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname IN
    ('onboarding_bootstrap','platform_admin','platform_admin_audit','background_job','background_job_review')
    AND (NOT relrowsecurity OR NOT relforcerowsecurity)) THEN RAISE EXCEPTION 'RLS postcondition failed'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND
    ((tablename='onboarding_bootstrap' AND policyname='onboarding_bootstrap_access' AND
      (qual <> '(clerk_sub = current_setting(''app.clerk_sub''::text, true))' OR with_check <> qual))
     OR (tablename IN ('platform_admin','platform_admin_audit') AND
      (qual IS NULL OR with_check IS NULL OR qual NOT LIKE '%pg_class%' OR with_check NOT LIKE '%pg_class%'))
     OR (tablename IN ('background_job','background_job_review') AND
      policyname='tenant_isolation' AND (qual <> '(tenant_id = app_tenant_id())' OR with_check <> qual)))) THEN
    RAISE EXCEPTION 'policy expression postcondition failed';
  END IF;
  SELECT count(*) INTO bad FROM pg_policies
   WHERE schemaname='public' AND tablename IN
     ('onboarding_bootstrap','platform_admin','platform_admin_audit','background_job','background_job_review');
  IF bad <> 7 THEN RAISE EXCEPTION 'expected exactly seven repair policies, observed %', bad; END IF;
  SELECT count(*) INTO bad FROM (VALUES
    ${expectedExecValues}
  ) AS x(signature, app_exec, queue_exec)
  WHERE to_regprocedure(x.signature) IS NULL
     OR has_function_privilege('public', to_regprocedure(x.signature), 'EXECUTE')
     OR has_function_privilege('arcompt_app', to_regprocedure(x.signature), 'EXECUTE') IS DISTINCT FROM x.app_exec
     OR has_function_privilege('arcompt_queue', to_regprocedure(x.signature), 'EXECUTE') IS DISTINCT FROM x.queue_exec
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure(x.signature)) <> 'neondb_owner'
     OR (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure(x.signature)) IS DISTINCT FROM true
     OR (SELECT proconfig FROM pg_proc WHERE oid=to_regprocedure(x.signature)) IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'];
  IF bad <> 0 THEN RAISE EXCEPTION 'function ownership, search_path, SECURITY DEFINER, or EXECUTE ACL failed (% rows)', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='platform_admin_audit_immutable' AND tgenabled='O') THEN
    RAISE EXCEPTION 'immutable audit trigger is not enabled';
  END IF;
  IF has_function_privilege('public', 'public.journal_entry_update_balances()', 'EXECUTE')
    OR has_function_privilege('arcompt_app', 'public.journal_entry_update_balances()', 'EXECUTE')
    OR has_function_privilege('arcompt_queue', 'public.journal_entry_update_balances()', 'EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.journal_entry_update_balances()'::regprocedure
      AND p.prosecdef AND pg_get_userbyid(p.proowner)='neondb_owner'
      AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
      AND pg_get_functiondef(p.oid) LIKE '%public.account_balance%'
      AND pg_get_functiondef(p.oid) LIKE '%public.journal_line%') THEN
    RAISE EXCEPTION 'ledger balance trigger definition, owner, or EXECUTE ACL differs';
  END IF;
  SELECT count(*) INTO bad
    FROM (
      SELECT acl.grantee, acl.privilege_type
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) acl
       WHERE n.nspname='public' AND c.relkind IN ('r','p','S')
         AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='arcompt_app')
      UNION ALL
      SELECT acl.grantee, acl.privilege_type
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        CROSS JOIN LATERAL aclexplode(a.attacl) acl
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
         AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='arcompt_app')
    ) grants;
  IF bad <> 278 THEN RAISE EXCEPTION 'development ACL manifest is not exact (observed % grants)', bad; END IF;
END $$;
-- Every expected manifest grant is checked; all application DML outside it is denied
-- by the revoke-all sweep above.  The complete 278-grant manifest follows.
`;

const aclReset = String.raw`DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f')
  LOOP
    EXECUTE format('REVOKE ALL ON %s %I.%I FROM arcompt_app',
      CASE WHEN r.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.nspname, r.relname);
  END LOOP;
END $$;`;

const sql = [
  "BEGIN;",
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '60s';",
  preflight,
  "CREATE ROLE arcompt_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;",
  "CREATE ROLE arcompt_queue NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;",
  "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
  "GRANT USAGE ON SCHEMA public TO arcompt_app, arcompt_queue;",
  "REVOKE ALL ON FUNCTION public.journal_entry_update_balances() FROM PUBLIC;",
  ...definitions,
  `REVOKE ALL ON FUNCTION ${signatures.map((s) => `public.${s}`).join(", ")} FROM PUBLIC, arcompt_app, arcompt_queue;\n${appFunctionGrants}`,
  "CREATE TRIGGER platform_admin_audit_immutable BEFORE UPDATE OR DELETE ON public.platform_admin_audit FOR EACH ROW EXECUTE FUNCTION public.forbid_change();",
  "ALTER TABLE public.onboarding_bootstrap FORCE ROW LEVEL SECURITY;",
  "ALTER TABLE public.platform_admin FORCE ROW LEVEL SECURITY;",
  "ALTER TABLE public.platform_admin_audit FORCE ROW LEVEL SECURITY;",
  "ALTER TABLE public.background_job FORCE ROW LEVEL SECURITY;",
  "ALTER TABLE public.background_job_review FORCE ROW LEVEL SECURITY;",
  "DROP POLICY IF EXISTS onboarding_bootstrap_access ON public.onboarding_bootstrap;",
  "CREATE POLICY onboarding_bootstrap_access ON public.onboarding_bootstrap USING (clerk_sub = current_setting('app.clerk_sub', true)) WITH CHECK (clerk_sub = current_setting('app.clerk_sub', true));",
  "DROP POLICY IF EXISTS platform_admin_internal ON public.platform_admin;",
  "CREATE POLICY platform_admin_internal ON public.platform_admin USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass));",
  "DROP POLICY IF EXISTS platform_admin_audit_internal ON public.platform_admin_audit;",
  "CREATE POLICY platform_admin_audit_internal ON public.platform_admin_audit USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass));",
  "DROP POLICY IF EXISTS background_job_owner ON public.background_job;",
  "DROP POLICY IF EXISTS tenant_isolation ON public.background_job;",
  "CREATE POLICY background_job_owner ON public.background_job USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job'::regclass));",
  "CREATE POLICY tenant_isolation ON public.background_job USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());",
  "DROP POLICY IF EXISTS background_job_review_owner ON public.background_job_review;",
  "DROP POLICY IF EXISTS tenant_isolation ON public.background_job_review;",
  "CREATE POLICY background_job_review_owner ON public.background_job_review USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass));",
  "CREATE POLICY tenant_isolation ON public.background_job_review USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());",
  aclReset,
  grants.toString().trim(),
  (await readFile(resolve(root, "packages/db/migrations/0027_queue_role.sql"), "utf8")).trim(),
  postExec,
  "COMMIT;",
].join("\n\n");

const review = [
  "# Private Publish Repair Review",
  "",
  "> **NOT APPROVED FOR PRODUCTION.** Candidate for an isolated rehearsal only. Do not execute against production/shared development or publish. This transaction does not replay the 13-statement preview and does not update ledger/data/passwords or provision a login.",
  "",
  "Important untested assumptions: the rehearsal database has the exact observed catalog gap, neondb_owner owns all required objects and may create group roles, forbid_change() exists, and the development ACL manifest remains current.",
  "",
  "```sql",
  sql,
  "```",
  "",
].join("\n");
await writeFile(out, review, "utf8");
console.log(`wrote ${out} (${expectedGrants.length} ACL grants, ${definitions.length} function definitions)`);