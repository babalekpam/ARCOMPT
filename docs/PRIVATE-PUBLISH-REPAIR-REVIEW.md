# Private Publish Repair Review

> **NOT APPROVED FOR PRODUCTION.** Candidate for an isolated rehearsal only. Do not execute against production/shared development or publish. This transaction does not replay the 13-statement preview and does not update ledger/data/passwords or provision a login.

Important untested assumptions: the rehearsal database has the exact observed catalog gap, neondb_owner owns all required objects and may create group roles, forbid_change() exists, and the development ACL manifest remains current.

```sql
BEGIN;

SET LOCAL lock_timeout = '5s';

SET LOCAL statement_timeout = '60s';

-- PREFLIGHT: deliberately before every DDL statement.
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
  END IF;
END $$;

CREATE ROLE arcompt_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE arcompt_queue NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO arcompt_app, arcompt_queue;

REVOKE ALL ON FUNCTION public.journal_entry_update_balances() FROM PUBLIC;

CREATE OR REPLACE FUNCTION auth_bootstrap_lookup(p_sub text, p_email text)
RETURNS TABLE (state text, company_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT company_id FROM public.onboarding_bootstrap WHERE clerk_sub = p_sub
$$;

CREATE OR REPLACE FUNCTION platform_admin_identity(p_sub text)
RETURNS TABLE(user_id uuid, suspended_at timestamptz, locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.suspended_at, u.locale
    FROM public.platform_admin pa
    JOIN public.app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_company(p_sub text, p_company uuid)
RETURNS TABLE(company_id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.id, c.organization_id
    FROM public.platform_admin pa
    JOIN public.app_user u ON u.id = pa.user_id
    JOIN public.company c ON c.id = p_company
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_companies(p_sub text)
RETURNS TABLE(company_id uuid, company_name text, organization_id uuid, organization_name text, country_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.id, c.name, c.organization_id, o.name, c.country_code::text
    FROM public.platform_admin pa
    JOIN public.app_user u ON u.id = pa.user_id
    JOIN public.company c ON true
    JOIN public.organization o ON o.id = c.organization_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
   ORDER BY o.name, c.name, c.id
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_record_access(
  p_sub text, p_company uuid, p_method text, p_path text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor uuid;
  v_org uuid;
BEGIN
  IF p_method IS NULL OR pg_catalog.btrim(p_method) = '' OR p_path IS NULL OR pg_catalog.btrim(p_path) = '' THEN
    RAISE EXCEPTION 'ARCOMPT: audit method and path are required' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor
    FROM public.platform_admin pa JOIN public.app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'ARCOMPT: platform admin inactive or unknown' USING ERRCODE = '28000';
  END IF;
  IF p_company IS NOT NULL THEN
    SELECT c.organization_id INTO v_org FROM public.company c WHERE c.id = p_company;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'ARCOMPT: company not found' USING ERRCODE = '23503';
    END IF;
  END IF;
  INSERT INTO public.platform_admin_audit(actor_user_id, company_id, organization_id, method, path, event)
  VALUES (v_actor, p_company, v_org, pg_catalog.upper(pg_catalog.btrim(p_method)), pg_catalog.btrim(p_path), 'ACCESS');
END;
$$;

CREATE OR REPLACE FUNCTION public.background_job_claim(p_names text[])
RETURNS SETOF public.background_job
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.background_job j
     SET status = 'RUNNING', attempts = j.attempts + 1,
         lock_token = public.gen_random_uuid(), locked_until = pg_catalog.now() + pg_catalog.interval '2 minutes'
   WHERE j.id = (
     SELECT id FROM public.background_job
      WHERE name = ANY(p_names)
        AND ((status = 'PENDING' AND run_at <= pg_catalog.now())
          OR (status = 'RUNNING' AND locked_until < pg_catalog.now() AND name <> 'dunning.send'))
        AND attempts < max_attempts
      ORDER BY run_at, created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
   )
  RETURNING j.*
$$;

CREATE OR REPLACE FUNCTION public.background_job_renew(p_id uuid, p_token uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH updated AS (
    UPDATE public.background_job SET locked_until = pg_catalog.now() + pg_catalog.interval '2 minutes'
    WHERE id = p_id AND lock_token = p_token AND status = 'RUNNING'
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM updated)
$$;

CREATE OR REPLACE FUNCTION public.background_job_finish(p_id uuid, p_token uuid, p_error text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH updated AS (
    UPDATE public.background_job
       SET status = CASE WHEN p_error IS NULL THEN 'DONE'
                         WHEN attempts >= max_attempts THEN 'FAILED'
                         ELSE 'PENDING' END,
           run_at = CASE WHEN p_error IS NULL THEN run_at
                         ELSE pg_catalog.now() + (LEAST(60000::double precision, backoff_ms * pg_catalog.power(2, attempts - 1)) * pg_catalog.interval '1 millisecond') END,
           last_error = pg_catalog.left(p_error, 2000), lock_token = NULL, locked_until = NULL
     WHERE id = p_id AND lock_token = p_token AND status = 'RUNNING'
     RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM updated)
$$;

CREATE OR REPLACE FUNCTION public.background_job_expire_reminders()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH expired AS (
    UPDATE public.background_job SET status = 'FAILED', last_error = 'Envoi incertain après interruption : vérifier avant de renvoyer',
      lock_token = NULL, locked_until = NULL
    WHERE status = 'RUNNING' AND (name = 'dunning.send' OR attempts >= max_attempts) AND locked_until < pg_catalog.now()
    RETURNING 1
  ) SELECT pg_catalog.count(*)::integer FROM expired
$$;

CREATE OR REPLACE FUNCTION public.background_job_retry_internal(p_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_job public.background_job%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.background_job
    WHERE id = p_id AND tenant_id = public.app_tenant_id() FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'FAILED'
    OR v_job.name NOT IN ('document.extract', 'import.statement') THEN
    RETURN false;
  END IF;
  UPDATE public.background_job SET status = 'PENDING', attempts = 0, last_error = NULL,
    run_at = pg_catalog.now(), locked_until = NULL, lock_token = NULL WHERE id = p_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.background_job_review_reminder(p_id uuid, p_reviewer uuid, p_outcome text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_job public.background_job%ROWTYPE;
DECLARE v_replacement uuid;
BEGIN
  IF p_outcome NOT IN ('DELIVERED', 'NOT_DELIVERED') OR p_reviewer IS NULL
    OR p_reviewer::text <> pg_catalog.current_setting('app.user_id', true) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_job FROM public.background_job
    WHERE id = p_id AND tenant_id = public.app_tenant_id() FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'FAILED' OR v_job.name <> 'dunning.send'
    OR EXISTS (SELECT 1 FROM public.background_job_review WHERE source_job_id = p_id) THEN
    RETURN NULL;
  END IF;
  IF p_outcome = 'NOT_DELIVERED' THEN
    v_replacement := public.gen_random_uuid();
    INSERT INTO public.background_job (id, tenant_id, name, payload, dedupe_key, max_attempts, backoff_ms)
      VALUES (v_replacement, v_job.tenant_id, v_job.name, v_job.payload,
        'review-' || p_id::text, 1, v_job.backoff_ms);
  END IF;
  INSERT INTO public.background_job_review (source_job_id, tenant_id, reviewer_id, outcome, replacement_job_id)
    VALUES (p_id, v_job.tenant_id, p_reviewer, p_outcome, v_replacement);
  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_resolve_identity(p_sub text)
RETURNS TABLE (user_id uuid, organization_id uuid, suspended_at timestamptz, mfa_required boolean, locale text, company_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.organization_id, u.suspended_at, o.mfa_required, u.locale, m.company_id, m.role
    FROM public.app_user u
    JOIN public.organization o ON o.id = u.organization_id
    LEFT JOIN (public.company_member m JOIN public.company c ON c.id = m.company_id) ON m.user_id = u.id AND c.organization_id = u.organization_id
   WHERE u.keycloak_sub = p_sub
   ORDER BY m.company_id
$$;

CREATE OR REPLACE FUNCTION public.auth_link_subject(p_sub text, p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id uuid; v_linked uuid; v_count integer;
BEGIN
  IF p_sub IS NULL OR pg_catalog.btrim(p_sub) = '' OR p_email IS NULL OR pg_catalog.btrim(p_email) = '' THEN RETURN NULL; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(pg_catalog.lower(pg_catalog.btrim(p_email))));
  IF EXISTS (SELECT 1 FROM public.app_user WHERE keycloak_sub = p_sub) THEN RETURN NULL; END IF;
  SELECT pg_catalog.count(*), pg_catalog.max(id::text)::uuid INTO v_count, v_id FROM public.app_user
    WHERE pg_catalog.lower(email) = pg_catalog.lower(pg_catalog.btrim(p_email));
  IF v_count <> 1 THEN RETURN NULL; END IF;
  UPDATE public.app_user SET keycloak_sub = p_sub WHERE id = v_id AND keycloak_sub IS NULL RETURNING id INTO v_linked;
  RETURN v_linked;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_touch_last_active(p_user uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.app_user SET last_active_at = pg_catalog.now() WHERE id = p_user
$$;

CREATE OR REPLACE FUNCTION public.organization_of_company(tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT organization_id FROM public.company WHERE id = tenant AND id = public.app_tenant_id()
$$;

CREATE OR REPLACE FUNCTION public.portal_dashboard(p_organization_id uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c record;
  v_has_proposals boolean;
  v_has_workflow boolean;
  v_workflow_col text;
  v_last_entry date;
  v_drafts integer;
  v_validated integer;
  v_proposals integer;
  v_open_periods integer;
  v_fy record;
  v_workflow text;
  v_stale_drafts integer;
  v_stale_periods integer;
  v_comments integer;
  v_missing integer;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM public.app_organization_id() THEN
    RAISE EXCEPTION 'ARCOMPT: organisation non autorisée' USING ERRCODE = '42501';
  END IF;
  v_has_proposals := pg_catalog.to_regclass('public.ai_proposal') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_proposal' AND column_name = 'status')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_proposal' AND column_name = 'tenant_id');
  v_has_workflow := pg_catalog.to_regclass('public.fiscal_year_workflow') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fiscal_year_workflow' AND column_name = 'fiscal_year_id');
  IF v_has_workflow THEN
    SELECT column_name INTO v_workflow_col FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fiscal_year_workflow' AND column_name IN ('state', 'status')
      ORDER BY CASE column_name WHEN 'state' THEN 0 ELSE 1 END LIMIT 1;
    v_has_workflow := v_workflow_col IS NOT NULL;
  END IF;
  FOR c IN SELECT * FROM public.company WHERE organization_id = p_organization_id ORDER BY name, id LOOP
    SELECT max(entry_date) INTO v_last_entry FROM public.journal_entry WHERE tenant_id = c.id AND status = 'VALIDATED';
    SELECT count(*) FILTER (WHERE status = 'DRAFT')::int, count(*) FILTER (WHERE status = 'VALIDATED')::int,
           count(*) FILTER (WHERE status = 'DRAFT' AND created_at < pg_catalog.now() - pg_catalog.interval '30 days')::int
      INTO v_drafts, v_validated, v_stale_drafts FROM public.journal_entry WHERE tenant_id = c.id;
    SELECT count(*)::int, count(*) FILTER (WHERE end_date < CURRENT_DATE - 60)::int
      INTO v_open_periods, v_stale_periods FROM public.period WHERE tenant_id = c.id AND status = 'OPEN';
    SELECT id, code, status, start_date, end_date INTO v_fy FROM public.fiscal_year
      WHERE tenant_id = c.id ORDER BY (status = 'OPEN') DESC, start_date DESC LIMIT 1;
    SELECT count(*)::int INTO v_comments FROM public.company_comment WHERE tenant_id = c.id AND NOT resolved;
    SELECT count(*)::int INTO v_missing FROM public.missing_document_request WHERE tenant_id = c.id AND received_document_id IS NULL;
    v_proposals := NULL;
    IF v_has_proposals THEN
      EXECUTE 'SELECT count(*)::int FROM public.ai_proposal WHERE tenant_id = $1 AND status = ''PENDING''' INTO v_proposals USING c.id;
    END IF;
    v_workflow := NULL;
    IF v_has_workflow AND v_fy.id IS NOT NULL THEN
      EXECUTE pg_catalog.format('SELECT %I::text FROM public.fiscal_year_workflow WHERE fiscal_year_id = $1 LIMIT 1', v_workflow_col)
        INTO v_workflow USING v_fy.id;
    END IF;
    RETURN NEXT pg_catalog.jsonb_build_object(
      'companyId', c.id, 'name', c.name, 'countryCode', c.country_code, 'currency', c.currency,
      'accountingSystem', c.accounting_system, 'packVersion', c.pack_version, 'lastEntryDate', v_last_entry,
      'draftCount', v_drafts, 'validatedCount', v_validated, 'pendingProposals', v_proposals,
      'openPeriods', v_open_periods,
      'fiscalYear', CASE WHEN v_fy.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
        'id', v_fy.id, 'code', v_fy.code, 'status', v_fy.status, 'startDate', v_fy.start_date, 'endDate', v_fy.end_date) END,
      'workflowState', v_workflow, 'anomalies', v_stale_drafts + v_stale_periods,
      'unresolvedComments', v_comments, 'missingDocuments', v_missing);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.invitation_by_token_hash(p_hash text)
RETURNS TABLE (id uuid, organization_id uuid, email text, role text, company_ids jsonb, expires_at timestamptz, accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.id, i.organization_id, i.email, i.role, i.company_ids, i.expires_at, i.accepted_at
    FROM public.invitation i WHERE i.token_hash = p_hash
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_resolve_phone(p_phone text)
RETURNS TABLE (tenant_id uuid, user_id uuid, conversation_id uuid, verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.tenant_id, c.user_id, c.id, c.verified_at
    FROM public.whatsapp_conversation c
   WHERE c.phone = pg_catalog.regexp_replace(p_phone, '[^0-9]', '', 'g') AND c.tenant_id IS NOT NULL
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.payment_link_resolve(p_provider text, p_provider_ref text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT l.tenant_id FROM public.payment_link l WHERE l.provider = p_provider AND l.provider_ref = p_provider_ref LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.journal_entry_update_balances() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'VALIDATED' AND (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') THEN
    INSERT INTO public.account_balance (tenant_id, account_id, period_id, debit, credit)
      SELECT NEW.tenant_id, l.account_id, NEW.period_id, sum(l.debit), sum(l.credit)
        FROM public.journal_line l WHERE l.entry_id = NEW.id
        GROUP BY l.account_id
    ON CONFLICT (tenant_id, account_id, period_id) DO UPDATE
      SET debit = public.account_balance.debit + EXCLUDED.debit,
          credit = public.account_balance.credit + EXCLUDED.credit;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.auth_bootstrap_lookup(text,text), public.auth_bootstrap_replay(text), public.platform_admin_identity(text), public.platform_admin_company(text,uuid), public.platform_admin_companies(text), public.platform_admin_record_access(text,uuid,text,text), public.background_job_retry_internal(uuid), public.background_job_review_reminder(uuid,uuid,text), public.background_job_claim(text[]), public.background_job_renew(uuid,uuid), public.background_job_finish(uuid,uuid,text), public.background_job_expire_reminders(), public.auth_resolve_identity(text), public.auth_link_subject(text,text), public.auth_touch_last_active(uuid), public.organization_of_company(uuid), public.portal_dashboard(uuid), public.invitation_by_token_hash(text), public.whatsapp_resolve_phone(text), public.payment_link_resolve(text,text) FROM PUBLIC, arcompt_app, arcompt_queue;
GRANT EXECUTE ON FUNCTION public.auth_bootstrap_lookup(text,text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.auth_bootstrap_replay(text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.platform_admin_identity(text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.platform_admin_company(text,uuid) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.platform_admin_companies(text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.platform_admin_record_access(text,uuid,text,text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.background_job_retry_internal(uuid) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.background_job_review_reminder(uuid,uuid,text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.auth_resolve_identity(text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.auth_link_subject(text,text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.auth_touch_last_active(uuid) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.organization_of_company(uuid) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.portal_dashboard(uuid) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.invitation_by_token_hash(text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.whatsapp_resolve_phone(text) TO arcompt_app;
GRANT EXECUTE ON FUNCTION public.payment_link_resolve(text,text) TO arcompt_app;

CREATE TRIGGER platform_admin_audit_immutable BEFORE UPDATE OR DELETE ON public.platform_admin_audit FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

ALTER TABLE public.onboarding_bootstrap FORCE ROW LEVEL SECURITY;

ALTER TABLE public.platform_admin FORCE ROW LEVEL SECURITY;

ALTER TABLE public.platform_admin_audit FORCE ROW LEVEL SECURITY;

ALTER TABLE public.background_job FORCE ROW LEVEL SECURITY;

ALTER TABLE public.background_job_review FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_bootstrap_access ON public.onboarding_bootstrap;

CREATE POLICY onboarding_bootstrap_access ON public.onboarding_bootstrap USING (clerk_sub = current_setting('app.clerk_sub', true)) WITH CHECK (clerk_sub = current_setting('app.clerk_sub', true));

DROP POLICY IF EXISTS platform_admin_internal ON public.platform_admin;

CREATE POLICY platform_admin_internal ON public.platform_admin USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass));

DROP POLICY IF EXISTS platform_admin_audit_internal ON public.platform_admin_audit;

CREATE POLICY platform_admin_audit_internal ON public.platform_admin_audit USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass));

DROP POLICY IF EXISTS background_job_owner ON public.background_job;

DROP POLICY IF EXISTS tenant_isolation ON public.background_job;

CREATE POLICY background_job_owner ON public.background_job USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job'::regclass));

CREATE POLICY tenant_isolation ON public.background_job USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS background_job_review_owner ON public.background_job_review;

DROP POLICY IF EXISTS tenant_isolation ON public.background_job_review;

CREATE POLICY background_job_review_owner ON public.background_job_review USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass)) WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass));

CREATE POLICY tenant_isolation ON public.background_job_review USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f')
  LOOP
    EXECUTE format('REVOKE ALL ON %s %I.%I FROM arcompt_app',
      CASE WHEN r.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.nspname, r.relname);
  END LOOP;
END $$;

-- Generated from the development pg_catalog; explicit grants only.
-- Default ACLs are intentionally excluded and must be asserted absent separately.
-- Role: arcompt_app

GRANT DELETE ON TABLE "public"."account" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."ai_proposal" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."app_user" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."asset_depreciation" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."bank_rule" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."bank_statement" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."bank_transaction" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."break_glass_request" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."cash_count" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."categorization_memory" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."categorization_rule" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."closing_checklist" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."company" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."company_comment" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."company_member" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."document" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."document_sequence" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."dunning" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."dunning_log" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."employee" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."exchange_rate" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."filing" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."fiscal_year" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."fiscal_year_workflow" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."fixed_asset" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."idempotency_record" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."invitation" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."invoicing_settings" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."journal" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."journal_entry" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."journal_line" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."missing_document_request" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."organization" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."organization_subscription" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."partner" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."payment" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."payment_allocation" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."payment_link" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."payroll_declaration" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."payroll_run" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."payslip" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."period" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."product" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."purchase_document" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."purchase_document_line" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."reconciliation" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."reconciliation_line" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."sales_document" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."sales_document_line" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."stock_article" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."stock_closing" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."stock_closing_line" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."stock_count" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."stock_count_line" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."stock_movement" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."tax_return" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."treasury_account" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."usage_counter" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."webhook_event" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."whatsapp_conversation" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."whatsapp_message" TO "arcompt_app";
GRANT DELETE ON TABLE "public"."whatsapp_webhook_receipt" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."account" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."admin_access_log" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."ai_call_log" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."ai_proposal" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."app_user" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."asset_depreciation" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."audit_log" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."background_job" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."bank_rule" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."bank_statement" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."bank_transaction" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."break_glass_request" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."cash_count" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."categorization_memory" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."categorization_rule" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."closing_checklist" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."company" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."company_comment" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."company_member" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."document" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."document_sequence" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."dunning" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."dunning_log" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."employee" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."exchange_rate" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."filing" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."fiscal_year" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."fiscal_year_workflow" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."fixed_asset" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."idempotency_record" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."invitation" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."invoicing_settings" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."journal" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."journal_entry" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."journal_line" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."ledger_anchor" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."missing_document_request" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."onboarding_bootstrap" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."organization" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."organization_subscription" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."partner" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payment" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payment_allocation" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payment_link" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payroll_declaration" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payroll_run" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payroll_tenant_key" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."payslip" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."period" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."product" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."purchase_document" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."purchase_document_line" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."reconciliation" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."reconciliation_line" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."sales_document" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."sales_document_line" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."stock_article" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."stock_closing" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."stock_closing_line" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."stock_count" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."stock_count_line" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."stock_movement" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."tax_return" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."treasury_account" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."usage_counter" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."webhook_event" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."whatsapp_conversation" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."whatsapp_message" TO "arcompt_app";
GRANT INSERT ON TABLE "public"."whatsapp_webhook_receipt" TO "arcompt_app";
GRANT SELECT ON SEQUENCE "public"."admin_access_log_id_seq" TO "arcompt_app";
GRANT SELECT ON SEQUENCE "public"."ai_call_log_id_seq" TO "arcompt_app";
GRANT SELECT ON SEQUENCE "public"."app_user_registration_number_seq" TO "arcompt_app";
GRANT SELECT ON SEQUENCE "public"."audit_log_id_seq" TO "arcompt_app";
GRANT SELECT ON SEQUENCE "public"."stock_movement_seq_seq" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."account" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."account_balance" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."admin_access_log" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."ai_call_log" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."ai_proposal" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."app_user" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."asset_depreciation" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."audit_log" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."background_job" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."background_job_review" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."bank_rule" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."bank_statement" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."bank_transaction" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."break_glass_request" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."cash_count" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."categorization_memory" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."categorization_rule" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."closing_checklist" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."company" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."company_comment" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."company_member" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."document" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."document_sequence" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."dunning" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."dunning_log" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."employee" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."exchange_rate" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."filing" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."fiscal_year" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."fiscal_year_workflow" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."fixed_asset" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."idempotency_record" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."invitation" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."invoicing_settings" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."journal" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."journal_entry" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."journal_line" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."ledger_anchor" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."missing_document_request" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."onboarding_bootstrap" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."organization" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."organization_subscription" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."partner" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payment" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payment_allocation" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payment_link" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payroll_declaration" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payroll_run" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payroll_tenant_key" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."payslip" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."period" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."product" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."purchase_document" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."purchase_document_line" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."reconciliation" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."reconciliation_line" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."sales_document" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."sales_document_line" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."stock_article" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."stock_closing" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."stock_closing_line" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."stock_count" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."stock_count_line" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."stock_movement" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."subscription_plan" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."tax_return" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."treasury_account" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."usage_counter" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."webhook_event" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."whatsapp_conversation" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."whatsapp_message" TO "arcompt_app";
GRANT SELECT ON TABLE "public"."whatsapp_webhook_receipt" TO "arcompt_app";
GRANT UPDATE ("dedupe_key") ON TABLE "public"."background_job" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."account" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."admin_access_log" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."ai_proposal" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."app_user" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."asset_depreciation" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."bank_rule" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."bank_statement" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."bank_transaction" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."break_glass_request" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."cash_count" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."categorization_memory" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."categorization_rule" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."closing_checklist" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."company" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."company_comment" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."company_member" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."document" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."document_sequence" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."dunning" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."dunning_log" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."employee" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."exchange_rate" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."filing" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."fiscal_year" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."fiscal_year_workflow" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."fixed_asset" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."idempotency_record" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."invitation" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."invoicing_settings" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."journal" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."journal_entry" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."journal_line" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."ledger_anchor" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."missing_document_request" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."organization" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."organization_subscription" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."partner" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payment" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payment_allocation" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payment_link" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payroll_declaration" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payroll_run" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payroll_tenant_key" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."payslip" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."period" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."product" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."purchase_document" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."purchase_document_line" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."reconciliation" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."reconciliation_line" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."sales_document" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."sales_document_line" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."stock_article" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."stock_closing" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."stock_closing_line" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."stock_count" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."stock_count_line" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."stock_movement" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."tax_return" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."treasury_account" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."usage_counter" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."webhook_event" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."whatsapp_conversation" TO "arcompt_app";
GRANT UPDATE ON TABLE "public"."whatsapp_message" TO "arcompt_app";
GRANT USAGE ON SEQUENCE "public"."admin_access_log_id_seq" TO "arcompt_app";
GRANT USAGE ON SEQUENCE "public"."ai_call_log_id_seq" TO "arcompt_app";
GRANT USAGE ON SEQUENCE "public"."app_user_registration_number_seq" TO "arcompt_app";
GRANT USAGE ON SEQUENCE "public"."audit_log_id_seq" TO "arcompt_app";
GRANT USAGE ON SEQUENCE "public"."stock_movement_seq_seq" TO "arcompt_app";

-- Queue claims are cross-tenant by design. Keep this capability out of the
-- HTTP application's role; the login is provisioned separately, never here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_queue') THEN
    CREATE ROLE arcompt_queue NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
REVOKE arcompt_app FROM arcompt_queue;
REVOKE ALL ON background_job, background_job_review FROM arcompt_queue;
GRANT USAGE ON SCHEMA public TO arcompt_queue;
REVOKE ALL ON FUNCTION background_job_claim(text[]), background_job_renew(uuid, uuid),
  background_job_finish(uuid, uuid, text), background_job_expire_reminders() FROM arcompt_app;
REVOKE ALL ON FUNCTION background_job_claim(text[]), background_job_renew(uuid, uuid),
  background_job_finish(uuid, uuid, text), background_job_expire_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION background_job_claim(text[]), background_job_renew(uuid, uuid),
  background_job_finish(uuid, uuid, text), background_job_expire_reminders() TO arcompt_queue;

DO $$
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
    ('public.auth_bootstrap_lookup(text,text)', true, false),
    ('public.auth_bootstrap_replay(text)', true, false),
    ('public.platform_admin_identity(text)', true, false),
    ('public.platform_admin_company(text,uuid)', true, false),
    ('public.platform_admin_companies(text)', true, false),
    ('public.platform_admin_record_access(text,uuid,text,text)', true, false),
    ('public.background_job_retry_internal(uuid)', true, false),
    ('public.background_job_review_reminder(uuid,uuid,text)', true, false),
    ('public.background_job_claim(text[])', false, true),
    ('public.background_job_renew(uuid,uuid)', false, true),
    ('public.background_job_finish(uuid,uuid,text)', false, true),
    ('public.background_job_expire_reminders()', false, true),
    ('public.auth_resolve_identity(text)', true, false),
    ('public.auth_link_subject(text,text)', true, false),
    ('public.auth_touch_last_active(uuid)', true, false),
    ('public.organization_of_company(uuid)', true, false),
    ('public.portal_dashboard(uuid)', true, false),
    ('public.invitation_by_token_hash(text)', true, false),
    ('public.whatsapp_resolve_phone(text)', true, false),
    ('public.payment_link_resolve(text,text)', true, false)
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


COMMIT;
```
