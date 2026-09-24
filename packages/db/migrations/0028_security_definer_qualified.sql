-- SECURITY DEFINER hardening: never resolve application objects through a
-- caller-controlled search_path.  Keep this as a forward migration; the
-- original definitions are intentionally left unchanged.

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

-- Preserve the existing grants, including queue-only access to claim/renew/
-- finish/expire (0027) and application access to the other functions.
REVOKE ALL ON FUNCTION public.platform_admin_company(text, uuid), public.platform_admin_companies(text),
  public.platform_admin_record_access(text, uuid, text, text), public.auth_resolve_identity(text),
  public.auth_link_subject(text, text), public.auth_touch_last_active(uuid),
  public.organization_of_company(uuid), public.invitation_by_token_hash(text), public.portal_dashboard(uuid),
  public.whatsapp_resolve_phone(text), public.payment_link_resolve(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_admin_company(text, uuid), public.platform_admin_companies(text),
  public.platform_admin_record_access(text, uuid, text, text), public.auth_resolve_identity(text),
  public.auth_link_subject(text, text), public.auth_touch_last_active(uuid),
  public.organization_of_company(uuid), public.invitation_by_token_hash(text), public.portal_dashboard(uuid),
  public.whatsapp_resolve_phone(text), public.payment_link_resolve(text, text) TO arcompt_app;
REVOKE ALL ON FUNCTION public.background_job_claim(text[]), public.background_job_renew(uuid, uuid),
  public.background_job_finish(uuid, uuid, text), public.background_job_expire_reminders() FROM PUBLIC, arcompt_app;
GRANT EXECUTE ON FUNCTION public.background_job_claim(text[]), public.background_job_renew(uuid, uuid),
  public.background_job_finish(uuid, uuid, text), public.background_job_expire_reminders() TO arcompt_queue;
REVOKE ALL ON FUNCTION public.background_job_retry_internal(uuid), public.background_job_review_reminder(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.background_job_retry_internal(uuid), public.background_job_review_reminder(uuid, uuid, text) TO arcompt_app;