# Private Publish SQL review plan (production; review-only)

**Status: not approved for execution.** This is a bounded SQL review package for
the Replit-managed production database after a **private** Publish. It contains
no production connection, password, secret, or instruction to run an unreviewed
bundle. No SQL was executed while preparing this document. It does not publish
the application or open public visibility.

**Nothing in this document is runnable SQL.** The fragments intentionally have
no signed final transaction, no complete postcondition block, and no approved
role-provisioning step. They are comparison material for a disposable
rehearsal. Do not paste them into the production SQL runner.

The authority for this plan is migrations `0001` through `0027`, compared with
read-only production and development catalogs and the current Publish preview.
The preview has 13 statements and adds the job tables with bare policies; it
does not add the forced RLS, owner policies, functions, grants, or queue role.

## 1. Observed facts and stop conditions

The read-only catalog comparison reported:

* production has `neondb_owner` as the existing table owner, while development
  tables are owned by `postgres`;
* `neondb_owner` has `BYPASSRLS`;
* `arcompt_app` and `arcompt_queue` group roles/logins are absent (there is no
  login provisioning result to reuse);
* `onboarding_bootstrap_access`, `platform_admin_internal`, and
  `platform_admin_audit_internal` exist without their migration conditions,
  and the affected tables do not have `FORCE ROW LEVEL SECURITY`;
* the 12 function names below are absent, and the
  `platform_admin_audit_immutable` trigger is absent;
* production records 16 migrations while development records 26. Migration
  records alone do not prove that objects exist.

The following are **not** acceptable assumptions: that all definer functions
must be owned by a non-`BYPASSRLS` role, that `postgres` ownership can be
copied into production, that a broad `neondb_owner` grant is an application
boundary, or that the Publish diff is equivalent to replaying migrations.
Review each definer's arguments, qualified references, owner, `prosecdef`,
`proconfig`, and `EXECUTE` grants. A `BYPASSRLS` owner may be acceptable only
after a separate review proves that the function's inputs, body, policies, and
grants cannot cross the intended boundary.

**Hard stop:** do not apply any candidate DDL until all preconditions pass,
the role/login design is approved by the operator, and the complete candidate
is rehearsed against a disposable production-shaped copy. A parser check is
not a rehearsal and does not prove safety.

## 2. Read-only preflight (run separately in both catalogs)

These are SELECT-only inventory queries. They inspect metadata, not accounting
rows. Save their results with the Publish diff and review them before drafting
the final statement set.

```sql
SELECT current_database(), current_user, session_user,
       current_setting('server_version'), rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin,
       rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname IN ('neondb_owner','postgres','arcompt_app',
                  'arcompt_app_login','arcompt_queue','arcompt_queue_login')
ORDER BY rolname;

SELECT member.rolname AS member_role, granted.rolname AS granted_role,
       am.admin_option
FROM pg_auth_members am
JOIN pg_roles granted ON granted.oid = am.roleid
JOIN pg_roles member ON member.oid = am.member
WHERE granted.rolname IN ('arcompt_app','arcompt_queue')
   OR member.rolname IN ('arcompt_app','arcompt_queue')
ORDER BY member_role, granted_role;

SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolbypassrls,
       rolconnlimit, rolvaliduntil
FROM pg_roles
WHERE rolname IN ('arcompt_app_login','arcompt_queue_login')
   OR rolname LIKE 'arcompt\_%\_login' ESCAPE '\'
ORDER BY rolname;

SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('onboarding_bootstrap','platform_admin',
    'platform_admin_reserved_org','platform_admin_audit',
    'background_job','background_job_review')
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd,
       qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('onboarding_bootstrap','platform_admin',
    'platform_admin_audit','background_job','background_job_review')
ORDER BY tablename, policyname;

SELECT n.nspname, p.oid::regprocedure, p.proowner::regrole AS owner,
       p.prosecdef, p.provolatile, p.proconfig,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
       COALESCE((SELECT has_function_privilege('arcompt_app', p.oid, 'EXECUTE')
                 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app')), false)
         AS app_execute,
       COALESCE((SELECT has_function_privilege('arcompt_queue', p.oid, 'EXECUTE')
                 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_queue')), false)
         AS queue_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
   AND p.proname IN ('auth_bootstrap_lookup','auth_bootstrap_replay',
     'platform_admin_identity','platform_admin_company',
    'platform_admin_companies','platform_admin_record_access',
    'background_job_claim','background_job_renew','background_job_finish',
    'background_job_expire_reminders','background_job_retry_internal',
     'background_job_review_reminder','auth_resolve_identity',
     'auth_link_subject','auth_touch_last_active','organization_of_company',
     'portal_dashboard','invitation_by_token_hash','whatsapp_resolve_phone',
     'payment_link_resolve')
ORDER BY p.oid::regprocedure::text;

SELECT tg.tgname, tg.tgenabled, c.relname, p.proname,
       pg_get_triggerdef(tg.oid)
FROM pg_trigger tg
JOIN pg_class c ON c.oid = tg.tgrelid
JOIN pg_proc p ON p.oid = tg.tgfoid
WHERE NOT tg.tgisinternal
  AND (tg.tgname = 'platform_admin_audit_immutable'
       OR c.relname IN ('platform_admin_audit','background_job',
                        'background_job_review'));

SELECT table_name, privilege_type, grantee
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('arcompt_app','arcompt_queue')
  AND table_name IN ('onboarding_bootstrap','platform_admin',
    'platform_admin_reserved_org','platform_admin_audit',
    'background_job','background_job_review')
ORDER BY grantee, table_name, privilege_type;

SELECT nspname, nspowner::regrole AS owner, nspacl
FROM pg_namespace
WHERE nspname = 'public';

SELECT routine_name, specific_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN ('auth_bootstrap_lookup','auth_bootstrap_replay',
    'platform_admin_identity','platform_admin_company',
    'platform_admin_companies','platform_admin_record_access',
    'background_job_claim','background_job_renew','background_job_finish',
    'background_job_expire_reminders','background_job_retry_internal',
    'background_job_review_reminder','auth_resolve_identity',
    'auth_link_subject','auth_touch_last_active','organization_of_company',
    'portal_dashboard','invitation_by_token_hash','whatsapp_resolve_phone',
    'payment_link_resolve')
ORDER BY routine_name, grantee;

SELECT name, applied_at
FROM schema_migration
ORDER BY name;
```

Also compare `pg_get_functiondef`, `pg_get_expr(polqual, ...)`, all table
constraints/indexes, and `pg_get_constraintdef` for the reserved-organization
singleton. For every `SECURITY DEFINER` covered by `0028`, require
`proconfig` to contain exactly `search_path=pg_catalog, public, pg_temp`
(and verify the definition uses the qualified `public.*` references from
`0028`). For the three bootstrap/identity functions not redefined by `0028`,
compare against their exact `0021` definitions and stop if the source is not
accepted. Record each `proowner`, `prosecdef`, ACL, and owner attributes;
there is no blanket requirement to replace a `BYPASSRLS` owner, but no
application login may own a definer. Do not use row samples or modify data for
this review.

## 3. Transaction-scoped guard (must precede every candidate DDL)

This is a guard template, not authorization to execute. It permits the
currently available managed migration owner only for a separately approved DDL
session, after checking its exact identity and catalog baseline. That owner's
`BYPASSRLS` is never acceptable for an API or worker runtime; the runtime must
use restricted logins and reject `neondb_owner`. The final rehearsal must
replace the catalog assertions with the exact approved production baseline and
add lock-timeout/statement-timeout settings.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE x boolean;
BEGIN
  SELECT (rolname = 'neondb_owner' AND NOT rolsuper AND rolbypassrls) INTO x
    FROM pg_roles
   WHERE rolname = current_user;
  IF current_user <> 'neondb_owner' OR COALESCE(x, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only the explicitly reviewed managed migration owner may run DDL';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'public.app_user','public.company','public.organization',
      'public.onboarding_bootstrap','public.platform_admin',
      'public.platform_admin_reserved_org','public.platform_admin_audit',
      'public.background_job','public.background_job_review'
    ]) AS d(object_name)
    WHERE to_regclass(d.object_name) IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'public.app_tenant_id()','public.app_organization_id()',
      'public.app_user_id()','public.forbid_change()'
    ]) AS d(function_name)
    WHERE to_regprocedure(d.function_name) IS NULL
  ) THEN
    RAISE EXCEPTION 'Required dependency is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app'
                AND NOT rolbypassrls AND NOT rolsuper)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_queue'
                AND NOT rolbypassrls AND NOT rolsuper AND NOT rolcreaterole) THEN
    RAISE EXCEPTION 'Restricted group roles are not provisioned';
  END IF;
END
$guard$;
-- Candidate DDL follows only after independent review and rehearsal.
-- ROLLBACK;  -- mandatory for this review rehearsal
```

The `forbid_change` assertion uses `to_regprocedure` because it is a function,
not a relation. The package is not runnable until all baseline assertions are
reviewed. A real production run, if separately approved, must end with
`COMMIT` only after post-DDL assertions pass; a failed assertion must roll back.

## 4. Function source of truth: 0028 (older blocks invalid)

Migration `0028_security_definer_qualified.sql` is now the source of truth for
every function it redefines. It replaces the older definitions from `0018`,
`0024`, and `0026` (and the corresponding platform/identity definitions from
`0021`) with
`search_path = pg_catalog, public, pg_temp`, qualified `public.*` application
objects, and qualified catalog/builtin calls where needed. It covers the
platform-admin and all background-job functions, plus the existing identity,
portal, invitation, WhatsApp, and payment-link definers. Important source fact:
`0028` does **not** redefine `auth_bootstrap_lookup`,
`auth_bootstrap_replay`, or `platform_admin_identity`; their latest source is
the qualified `0021` definition. Making `0028` the sole source for those three
requires a separate migration-source change and is a review stop gate, not an
edit to this document's SQL.

**Every SQL function block in the remainder of this section that was copied
from an earlier migration is stale, invalidated, and must not be executed or
used as a candidate.** It is retained only as a historical gap explanation;
the exact current text must be read directly from `0028` and independently
rehearsed. This document intentionally does not duplicate the 0028 bundle.
The body of a `VOLATILE` function can perform SQL writes when called; including
operational SQL in a definition does not execute it. Calls and data backfills
are outside this plan and are prohibited here.

### Historical bootstrap/platform blocks — INVALID

```sql
CREATE OR REPLACE FUNCTION auth_bootstrap_lookup(p_sub text, p_email text)
RETURNS TABLE (state text, company_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  SELECT b.company_id INTO company_id FROM public.onboarding_bootstrap b WHERE b.clerk_sub = p_sub;
  IF company_id IS NOT NULL THEN state := 'REPLAY'; RETURN NEXT; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.app_user WHERE keycloak_sub = p_sub) THEN state := 'SUBJECT_LINKED'; RETURN NEXT; RETURN; END IF;
  IF (SELECT count(*) FROM public.app_user WHERE lower(email) = lower(btrim(p_email))) > 1 THEN
    state := 'EMAIL_AMBIGUOUS'; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_user u WHERE lower(u.email) = lower(btrim(p_email)) AND u.suspended_at IS NOT NULL) THEN
    state := 'SUSPENDED'; RETURN NEXT; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_user WHERE lower(email) = lower(btrim(p_email))) THEN
    state := 'ELIGIBLE'; RETURN NEXT; RETURN;
  END IF;
  state := 'EMAIL_LINKED'; RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION auth_bootstrap_replay(p_sub text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT company_id FROM public.onboarding_bootstrap WHERE clerk_sub = p_sub
$$;

CREATE OR REPLACE FUNCTION platform_admin_identity(p_sub text)
RETURNS TABLE(user_id uuid, suspended_at timestamptz, locale text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.suspended_at, u.locale
    FROM public.platform_admin pa JOIN public.app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;
```

The blocks above are historical `0021` text and are invalidated by `0028`;
do not restore them or the earlier unqualified `0018`/`0020` variants.

```sql
-- INVALID HISTORICAL 0018 TEXT: do not execute; use 0028 instead.
CREATE OR REPLACE FUNCTION platform_admin_company(p_sub text, p_company uuid)
RETURNS TABLE(company_id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.organization_id
    FROM platform_admin pa JOIN app_user u ON u.id = pa.user_id
    JOIN company c ON c.id = p_company
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;

CREATE OR REPLACE FUNCTION platform_admin_companies(p_sub text)
RETURNS TABLE(company_id uuid, company_name text, organization_id uuid,
              organization_name text, country_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, c.organization_id, o.name, c.country_code::text
    FROM platform_admin pa JOIN app_user u ON u.id = pa.user_id
    JOIN company c ON true JOIN organization o ON o.id = c.organization_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
   ORDER BY o.name, c.name, c.id
$$;

CREATE OR REPLACE FUNCTION platform_admin_record_access(
  p_sub text, p_company uuid, p_method text, p_path text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid; v_org uuid;
BEGIN
  IF p_method IS NULL OR btrim(p_method) = '' OR p_path IS NULL OR btrim(p_path) = '' THEN
    RAISE EXCEPTION 'ARCOMPT: audit method and path are required' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM platform_admin pa JOIN app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'ARCOMPT: platform admin inactive or unknown' USING ERRCODE = '28000';
  END IF;
  IF p_company IS NOT NULL THEN
    SELECT c.organization_id INTO v_org FROM company c WHERE c.id = p_company;
    IF v_org IS NULL THEN RAISE EXCEPTION 'ARCOMPT: company not found' USING ERRCODE = '23503'; END IF;
  END IF;
  INSERT INTO platform_admin_audit(actor_user_id, company_id, organization_id, method, path, event)
  VALUES (v_actor, p_company, v_org, upper(btrim(p_method)), btrim(p_path), 'ACCESS');
END;
$$;
```

The platform blocks above are invalidated `0018` bodies. `0028` is the
separately reviewed forward source that performs the hardening; this plan must
not improvise any further body or search-path edits in production.

### Queue and failed-job functions

The historical bodies for the six missing job functions below are invalidated
by `0028`; use its exact definitions instead. They contain
`UPDATE`/`INSERT` statements inside function bodies by design. Those statements
are not executed by defining the functions. They must not be granted to
`arcompt_app`: migration `0027` revokes them from that role and grants only
`arcompt_queue` the four cross-tenant claim/renew/finish/expire functions.
The two review functions are tenant-scoped and migration `0026` grants them
to `arcompt_app`.

Before approval, the reviewer must attach the literal `0028` function text and
prove, on the disposable copy, that:

```sql
-- INVALID HISTORICAL 0024/0026 TEXT: do not execute; use 0028 instead.
CREATE FUNCTION background_job_claim(p_names text[])
RETURNS SETOF background_job
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE background_job j
     SET status = 'RUNNING', attempts = j.attempts + 1,
         lock_token = gen_random_uuid(), locked_until = now() + interval '2 minutes'
   WHERE j.id = (
     SELECT id FROM background_job
      WHERE name = ANY(p_names)
        AND ((status = 'PENDING' AND run_at <= now())
          OR (status = 'RUNNING' AND locked_until < now() AND name <> 'dunning.send'))
        AND attempts < max_attempts
      ORDER BY run_at, created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
   )
   RETURNING j.*
$$;

CREATE FUNCTION background_job_renew(p_id uuid, p_token uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH updated AS (
    UPDATE background_job SET locked_until = now() + interval '2 minutes'
    WHERE id = p_id AND lock_token = p_token AND status = 'RUNNING'
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM updated)
$$;

CREATE FUNCTION background_job_finish(p_id uuid, p_token uuid, p_error text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH updated AS (
    UPDATE background_job
       SET status = CASE WHEN p_error IS NULL THEN 'DONE'
                         WHEN attempts >= max_attempts THEN 'FAILED'
                         ELSE 'PENDING' END,
           run_at = CASE WHEN p_error IS NULL THEN run_at
                         ELSE now() + (least(60000, backoff_ms * power(2, attempts - 1)) * interval '1 millisecond') END,
           last_error = left(p_error, 2000), lock_token = NULL, locked_until = NULL
     WHERE id = p_id AND lock_token = p_token AND status = 'RUNNING'
     RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM updated)
$$;

CREATE FUNCTION background_job_expire_reminders()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH expired AS (
    UPDATE background_job SET status = 'FAILED',
      last_error = 'Envoi incertain après interruption : vérifier avant de renvoyer',
      lock_token = NULL, locked_until = NULL
    WHERE status = 'RUNNING'
      AND (name = 'dunning.send' OR attempts >= max_attempts)
      AND locked_until < now()
    RETURNING 1
  ) SELECT count(*)::integer FROM expired
$$;

CREATE FUNCTION background_job_retry_internal(p_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job background_job%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM background_job
    WHERE id = p_id AND tenant_id = app_tenant_id() FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'FAILED'
    OR v_job.name NOT IN ('document.extract', 'import.statement') THEN
    RETURN false;
  END IF;
  UPDATE background_job SET status = 'PENDING', attempts = 0, last_error = NULL,
    run_at = now(), locked_until = NULL, lock_token = NULL WHERE id = p_id;
  RETURN true;
END;
$$;

CREATE FUNCTION background_job_review_reminder(p_id uuid, p_reviewer uuid, p_outcome text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job background_job%ROWTYPE;
DECLARE v_replacement uuid;
BEGIN
  IF p_outcome NOT IN ('DELIVERED', 'NOT_DELIVERED') OR p_reviewer IS NULL
    OR p_reviewer::text <> current_setting('app.user_id', true) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_job FROM background_job
    WHERE id = p_id AND tenant_id = app_tenant_id() FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'FAILED' OR v_job.name <> 'dunning.send'
    OR EXISTS (SELECT 1 FROM background_job_review WHERE source_job_id = p_id) THEN
    RETURN NULL;
  END IF;
  IF p_outcome = 'NOT_DELIVERED' THEN
    v_replacement := gen_random_uuid();
    INSERT INTO background_job (id, tenant_id, name, payload, dedupe_key, max_attempts, backoff_ms)
      VALUES (v_replacement, v_job.tenant_id, v_job.name, v_job.payload,
        'review-' || p_id::text, 1, v_job.backoff_ms);
  END IF;
  INSERT INTO background_job_review
    (source_job_id, tenant_id, reviewer_id, outcome, replacement_job_id)
    VALUES (p_id, v_job.tenant_id, p_reviewer, p_outcome, v_replacement);
  RETURN p_id;
END;
$$;
```

1. the owner is the approved non-login definer owner (not an application
   login), with the BYPASSRLS decision documented;
2. `background_job` and `background_job_review` have `FORCE ROW LEVEL
   SECURITY`, tenant policies, and owner-only policies;
3. `EXECUTE` is revoked from `PUBLIC` and the four cross-tenant functions are
   executable only by `arcompt_queue`;
4. worker inputs cannot claim another tenant's job except for the explicitly
   reviewed queue capability; and
5. the two review functions cannot create a replacement reminder without the
   required reviewer context and review row.

## 5. Exact policy, trigger, and grant candidates

Only after ownership and role preconditions are proven, these migration-derived
statements may be considered:

```sql
ALTER TABLE onboarding_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_bootstrap FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS onboarding_bootstrap_access ON onboarding_bootstrap;
CREATE POLICY onboarding_bootstrap_access ON onboarding_bootstrap
  USING (clerk_sub = current_setting('app.clerk_sub', true))
  WITH CHECK (clerk_sub = current_setting('app.clerk_sub', true));

ALTER TABLE platform_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admin_internal ON platform_admin;
DROP POLICY IF EXISTS platform_admin_audit_internal ON platform_admin_audit;
CREATE POLICY platform_admin_internal ON platform_admin
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass));
CREATE POLICY platform_admin_audit_internal ON platform_admin_audit
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass));

CREATE TRIGGER platform_admin_audit_immutable
  BEFORE UPDATE OR DELETE ON platform_admin_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE background_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON background_job;
CREATE POLICY tenant_isolation ON background_job
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY background_job_owner ON background_job
  USING (CURRENT_USER = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job'::regclass))
  WITH CHECK (CURRENT_USER = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job'::regclass));
ALTER TABLE background_job_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job_review FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON background_job_review;
CREATE POLICY tenant_isolation ON background_job_review
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY background_job_review_owner ON background_job_review
  USING (CURRENT_USER = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass))
  WITH CHECK (CURRENT_USER = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass));

REVOKE ALL ON FUNCTION auth_bootstrap_lookup(text,text),
  auth_bootstrap_replay(text), platform_admin_identity(text),
  platform_admin_company(text,uuid), platform_admin_companies(text),
  platform_admin_record_access(text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_bootstrap_lookup(text,text),
  auth_bootstrap_replay(text), platform_admin_identity(text),
  platform_admin_company(text,uuid), platform_admin_companies(text),
  platform_admin_record_access(text,uuid,text,text) TO arcompt_app;

GRANT SELECT, INSERT ON onboarding_bootstrap TO arcompt_app;
GRANT SELECT, INSERT ON background_job TO arcompt_app;
GRANT UPDATE (dedupe_key) ON background_job TO arcompt_app;
GRANT SELECT ON background_job_review TO arcompt_app;
GRANT USAGE ON SCHEMA public TO arcompt_app;
GRANT USAGE ON SCHEMA public TO arcompt_queue;
REVOKE arcompt_app FROM arcompt_queue;
REVOKE ALL ON background_job, background_job_review FROM arcompt_queue;
REVOKE ALL ON FUNCTION background_job_claim(text[]),
  background_job_renew(uuid,uuid), background_job_finish(uuid,uuid,text),
  background_job_expire_reminders() FROM PUBLIC, arcompt_app;
GRANT EXECUTE ON FUNCTION background_job_claim(text[]),
  background_job_renew(uuid,uuid), background_job_finish(uuid,uuid,text),
  background_job_expire_reminders() TO arcompt_queue;
REVOKE ALL ON FUNCTION background_job_retry_internal(uuid),
  background_job_review_reminder(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION background_job_retry_internal(uuid),
  background_job_review_reminder(uuid,uuid,text) TO arcompt_app;
```

The trigger statement is not idempotent; the rehearsal must use an explicit
`DROP TRIGGER IF EXISTS` only if the catalog proves that replacing an existing
trigger is intended. Do not add role memberships, table ownership changes,
`ALTER ROLE ... PASSWORD`, or data updates to this plan.

## 6. Role/login provisioning is a separate unresolved operation

`0010` and `0027` create only `NOLOGIN` group roles. The login provisioning
script is outside migrations. Production currently has neither group role nor
login. A restricted login, its secret, `LOGIN/NOSUPERUSER/NOBYPASSRLS`,
`IN ROLE` membership, connection limits, rotation, and Replit secret wiring
require a separately approved, Replit-supported operator procedure. Passwords
must never appear in this document, SQL history, logs, or chat. Until that
procedure succeeds, no API or worker `APP_DATABASE_URL` can be approved.

The queue worker needs a **separate** queue login mapped only to
`arcompt_queue`; it must not inherit `arcompt_app`, and the HTTP login must not
inherit `arcompt_queue`. The operator must provision the queue secret through
the supported Replit Secrets flow, bind it only to the worker environment,
verify the login's `rolcanlogin`, `rolsuper`, `rolbypassrls`, `rolcreaterole`,
`rolcreatedb`, and membership, and test rotation/revocation without printing
the credential. The app login gets only `arcompt_app`; no password or connection
string is specified here.

In particular, do not use `neondb_owner` for the API or worker. Do not claim
that changing every function owner is required; review definer ownership and
effective privileges individually.

## 7. Validation and operator sequence

No SQL parser or disposable rehearsal has been run for this document. A
successful syntax parse would still not make it runnable. Before any
production approval:

1. Capture a fresh read-only catalog and the Publish preview while visibility
   remains private; resolve every rename explicitly.
2. Recreate the relevant schema/roles on a disposable production-shaped
   database, apply the exact reviewed objects in one transaction, and run
   tenant-isolation, privilege, trigger, function-owner, and rollback tests.
   Record parser and PostgreSQL version results. Do not use production data.
3. Have an independent reviewer sign off the role/login boundary, every
   `SECURITY DEFINER`, and the cross-tenant queue exception.
4. In Publish, select Reserved VM and **private/invited collaborators only**.
   Do not connect a public domain or enable public visibility.
5. Review the generated diff; do not approve the bare job-table policies as
   complete. If a supported SQL runner is separately authorized, paste only
   the independently approved, rehearsed statements, with the transaction
   guard, and stop on any failed assertion. Never run migration files
   wholesale or an unreviewed bundle.
6. Put only restricted, production-only connection secrets in Replit Secrets.
   Start API and worker with their approved restricted logins, then check
   connected role, `/ready`, forced RLS, policy expressions, function
   privileges, and queue capability.
7. While still private, run smoke tests using disposable objects: login and
   tenant denials, onboarding replay, platform-admin audit immutability,
   queue claim/renew/finish isolation, failed-reminder review, scanner
   readiness/fail-closed behavior, same-origin proxy, and R2 put/get/delete.
   Keep the site private or unpublish on any failure.

### Explicit stop gates

Stop and do not continue if any of these is true: the fresh catalog differs
from the stated baseline; any dependency, owner, ACL, policy expression,
`FORCE` flag, trigger, or function setting is unresolved; either restricted
group role/login is absent or has unexpected attributes; `neondb_owner` is
configured as an API/worker runtime login; the parser/rehearsal did not run
against the exact text; a rehearsal postcondition fails; or the Publish diff
would leave a bare/unconditioned policy. The final approved artifact must add
post-DDL assertions for every object and privilege above, and a final
transaction outcome; this document intentionally does not claim that artifact
exists.

This document authorizes preparation for review only. It authorizes neither
production SQL execution nor a public deployment.