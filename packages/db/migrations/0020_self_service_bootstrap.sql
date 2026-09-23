-- Self-service Clerk onboarding is keyed by the verified provider subject.
-- It is deliberately separate from invitation acceptance and is replay-safe.
CREATE TABLE onboarding_bootstrap (
  clerk_sub text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES company(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE onboarding_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_bootstrap FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_bootstrap_access ON onboarding_bootstrap
  USING (clerk_sub = current_setting('app.clerk_sub', true))
  WITH CHECK (clerk_sub = current_setting('app.clerk_sub', true));
GRANT SELECT, INSERT ON onboarding_bootstrap TO arcompt_app;

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
REVOKE ALL ON FUNCTION auth_bootstrap_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_bootstrap_lookup(text, text) TO arcompt_app;

CREATE OR REPLACE FUNCTION auth_bootstrap_replay(p_sub text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT company_id FROM public.onboarding_bootstrap WHERE clerk_sub = p_sub
$$;
REVOKE ALL ON FUNCTION auth_bootstrap_replay(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_bootstrap_replay(text) TO arcompt_app;

-- The platform resolver is called on every Clerk request too. Keep temporary
-- test/session tables from shadowing its SECURITY DEFINER lookup.
CREATE OR REPLACE FUNCTION platform_admin_identity(p_sub text)
RETURNS TABLE(user_id uuid, suspended_at timestamptz, locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.suspended_at, u.locale
    FROM public.platform_admin pa
    JOIN public.app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform_admin_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_identity(text) TO arcompt_app;