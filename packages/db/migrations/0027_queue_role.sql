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