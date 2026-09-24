-- Production readiness requires FORCE RLS on every protected table. The
-- SECURITY DEFINER claim/ack functions still need to operate across tenants:
-- grant the table owner a separate, owner-only policy, never the app login.
ALTER TABLE background_job FORCE ROW LEVEL SECURITY;
CREATE POLICY background_job_owner ON background_job
  USING (
    CURRENT_USER = (
      SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.oid = 'background_job'::regclass
    )
  )
  WITH CHECK (
    CURRENT_USER = (
      SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.oid = 'background_job'::regclass
    )
  );