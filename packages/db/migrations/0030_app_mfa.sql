-- App-owned factors are independent of app_user/onboarding. Only encrypted
-- secrets and hashes cross the DB boundary; no tenant context grants access.
CREATE TABLE app_mfa_factor (
  clerk_sub text PRIMARY KEY CHECK (length(clerk_sub) BETWEEN 1 AND 256),
  secret_cipher text,
  pending_until timestamptz,
  enabled_at timestamptz,
  last_step bigint NOT NULL DEFAULT -1,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  attempt_start timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE app_mfa_proof (
  proof_hash text PRIMARY KEY CHECK (proof_hash ~ '^[a-f0-9]{64}$'),
  clerk_sub text NOT NULL REFERENCES app_mfa_factor(clerk_sub) ON DELETE CASCADE,
  clerk_sid text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE app_mfa_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_mfa_factor FORCE ROW LEVEL SECURITY;
ALTER TABLE app_mfa_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_mfa_proof FORCE ROW LEVEL SECURITY;
CREATE POLICY app_mfa_factor_internal ON app_mfa_factor
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'app_mfa_factor'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'app_mfa_factor'::regclass));
CREATE POLICY app_mfa_proof_internal ON app_mfa_proof
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'app_mfa_proof'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'app_mfa_proof'::regclass));
REVOKE ALL ON app_mfa_factor, app_mfa_proof FROM PUBLIC, arcompt_app;

-- MUST be called in its own committed statement before checking a code.
-- Success does not reset this budget, nor does replacing a pending factor.
CREATE FUNCTION app_mfa_attempt(p_sub text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.app_mfa_factor;
BEGIN
  INSERT INTO public.app_mfa_factor(clerk_sub) VALUES(p_sub) ON CONFLICT DO NOTHING;
  SELECT * INTO f FROM public.app_mfa_factor WHERE clerk_sub = p_sub FOR UPDATE;
  IF f.attempt_start <= clock_timestamp() - interval '15 minutes' THEN
    UPDATE public.app_mfa_factor SET attempt_start = clock_timestamp(), attempts = 1 WHERE clerk_sub = p_sub;
    RETURN true;
  END IF;
  IF f.attempts >= 10 THEN RETURN false; END IF;
  UPDATE public.app_mfa_factor SET attempts = attempts + 1 WHERE clerk_sub = p_sub;
  RETURN true;
END $$;

CREATE FUNCTION app_mfa_enroll(p_sub text, p_cipher text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE until_at timestamptz;
BEGIN
  IF length(p_cipher) > 1024 THEN RETURN NULL; END IF;
  UPDATE public.app_mfa_factor SET secret_cipher = p_cipher,
    pending_until = clock_timestamp() + interval '10 minutes', last_step = -1
    WHERE clerk_sub = p_sub AND enabled_at IS NULL
    RETURNING pending_until INTO until_at;
  RETURN until_at;
END $$;

-- Locks are held by the API verification transaction through completion.
CREATE FUNCTION app_mfa_lock(p_sub text)
RETURNS TABLE(secret_cipher text, enabled boolean, pending_until timestamptz, last_step bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT f.secret_cipher, f.enabled_at IS NOT NULL, f.pending_until, f.last_step
  FROM public.app_mfa_factor f WHERE f.clerk_sub = p_sub FOR UPDATE
$$;

CREATE FUNCTION app_mfa_status(p_sub text, p_sid text, p_hash text)
RETURNS TABLE(enabled boolean, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT f.enabled_at IS NOT NULL,
    (SELECT p.expires_at FROM public.app_mfa_proof p WHERE p.clerk_sub = p_sub
       AND p.clerk_sid = p_sid AND p.proof_hash = p_hash AND p.expires_at > now()
       AND f.enabled_at IS NOT NULL)
    FROM public.app_mfa_factor f WHERE f.clerk_sub = p_sub
$$;

-- A trusted server verifies RFC6238 before passing a step. This function
-- atomically enforces replay/one-use even if concurrent API workers race.
CREATE FUNCTION app_mfa_complete(p_sub text, p_sid text, p_cipher text, p_step bigint,
  p_recovery text, p_proof text, p_codes text[], p_mode text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.app_mfa_factor; until_at timestamptz;
BEGIN
  SELECT * INTO f FROM public.app_mfa_factor WHERE clerk_sub = p_sub FOR UPDATE;
  IF NOT FOUND OR f.secret_cipher IS DISTINCT FROM p_cipher OR p_mode NOT IN ('confirm','verify','recovery-codes') THEN RETURN NULL; END IF;
  IF p_mode = 'confirm' THEN
    IF f.enabled_at IS NOT NULL OR f.pending_until IS NULL OR f.pending_until <= clock_timestamp() THEN RETURN NULL; END IF;
  ELSIF f.enabled_at IS NULL THEN RETURN NULL;
  END IF;
  IF p_step IS NOT NULL THEN
    IF p_step <= f.last_step OR abs(p_step - floor(extract(epoch FROM clock_timestamp()) / 30)::bigint) > 1 THEN RETURN NULL; END IF;
  ELSE
    IF p_mode <> 'verify' OR p_recovery IS NULL OR NOT (p_recovery = ANY(f.recovery_hashes)) THEN RETURN NULL; END IF;
  END IF;
  IF p_mode IN ('confirm','recovery-codes') AND (cardinality(p_codes) IS DISTINCT FROM 10) THEN RETURN NULL; END IF;
  UPDATE public.app_mfa_factor SET
    enabled_at = coalesce(enabled_at, clock_timestamp()), pending_until = NULL,
    last_step = coalesce(p_step, last_step),
    recovery_hashes = CASE WHEN p_mode IN ('confirm','recovery-codes') THEN p_codes
      WHEN p_step IS NULL THEN array_remove(recovery_hashes, p_recovery) ELSE recovery_hashes END
    WHERE clerk_sub = p_sub;
  -- Bound storage and invalidate earlier proofs for the same Clerk session.
  DELETE FROM public.app_mfa_proof WHERE expires_at <= clock_timestamp()
    OR (clerk_sub = p_sub AND (clerk_sid = p_sid OR p_mode = 'recovery-codes'));
  until_at := clock_timestamp() + interval '15 minutes';
  IF p_mode <> 'recovery-codes' THEN
    INSERT INTO public.app_mfa_proof VALUES (p_proof, p_sub, p_sid, until_at);
  END IF;
  RETURN until_at;
END $$;
REVOKE ALL ON FUNCTION app_mfa_attempt(text), app_mfa_enroll(text,text),
  app_mfa_lock(text), app_mfa_status(text,text,text),
  app_mfa_complete(text,text,text,bigint,text,text,text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_attempt(text), app_mfa_enroll(text,text),
  app_mfa_lock(text), app_mfa_status(text,text,text),
  app_mfa_complete(text,text,text,bigint,text,text,text[],text) TO arcompt_app;