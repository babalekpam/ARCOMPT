-- Durable jobs on Replit, where API and worker processes cannot share memory.
CREATE TABLE background_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name IN ('document.extract', 'import.statement', 'dunning.send')),
  payload jsonb NOT NULL,
  dedupe_key text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  backoff_ms integer NOT NULL DEFAULT 1000 CHECK (backoff_ms BETWEEN 0 AND 60000),
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  lock_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, dedupe_key)
);
CREATE INDEX background_job_ready_idx ON background_job(run_at) WHERE status IN ('PENDING', 'RUNNING');
ALTER TABLE background_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON background_job USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON background_job TO arcompt_app;
GRANT UPDATE (dedupe_key) ON background_job TO arcompt_app;

-- The app role can only claim a job with one of the registered names. Lock tokens
-- prevent an expired runner from acknowledging another runner's attempt.
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
-- A reminder with an uncertain outcome must never be automatically resent.
-- A failed/expired reminder requires human review before a new send is requested.
CREATE FUNCTION background_job_expire_reminders()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH expired AS (
    UPDATE background_job SET status = 'FAILED', last_error = 'Envoi incertain après interruption : vérifier avant de renvoyer',
      lock_token = NULL, locked_until = NULL
    WHERE status = 'RUNNING' AND (name = 'dunning.send' OR attempts >= max_attempts) AND locked_until < now()
    RETURNING 1
  ) SELECT count(*)::integer FROM expired
$$;
REVOKE ALL ON FUNCTION background_job_claim(text[]), background_job_renew(uuid, uuid),
  background_job_finish(uuid, uuid, text), background_job_expire_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION background_job_claim(text[]), background_job_renew(uuid, uuid),
  background_job_finish(uuid, uuid, text), background_job_expire_reminders() TO arcompt_app;