-- Failed reminder delivery must be investigated by a human. Keep the original
-- FAILED job as evidence and record the decision before creating another send.
CREATE TABLE background_job_review (
  source_job_id uuid PRIMARY KEY REFERENCES background_job(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('DELIVERED', 'NOT_DELIVERED')),
  replacement_job_id uuid REFERENCES background_job(id),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE background_job_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_job_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON background_job_review
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY background_job_review_owner ON background_job_review
  USING (CURRENT_USER = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass))
  WITH CHECK (CURRENT_USER = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'background_job_review'::regclass));
GRANT SELECT ON background_job_review TO arcompt_app;

-- This function cannot retry external sends. Locking the FAILED row also
-- prevents concurrent staff requests from both resetting the same attempt.
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
  INSERT INTO background_job_review (source_job_id, tenant_id, reviewer_id, outcome, replacement_job_id)
    VALUES (p_id, v_job.tenant_id, p_reviewer, p_outcome, v_replacement);
  RETURN p_id;
END;
$$;
REVOKE ALL ON FUNCTION background_job_retry_internal(uuid), background_job_review_reminder(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION background_job_retry_internal(uuid), background_job_review_reminder(uuid,uuid,text) TO arcompt_app;