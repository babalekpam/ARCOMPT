-- Reconcile development databases that already applied the first draft.
ALTER TABLE platform_admin_audit ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE platform_admin_audit ADD COLUMN IF NOT EXISTS subject_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT;
ALTER TABLE platform_admin_audit ADD COLUMN IF NOT EXISTS operator_label text;
ALTER TABLE platform_admin_audit ADD COLUMN IF NOT EXISTS database_role text NOT NULL DEFAULT current_user;
CREATE TABLE IF NOT EXISTS platform_admin_reserved_org (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  organization_id uuid NOT NULL UNIQUE REFERENCES organization(id) ON DELETE RESTRICT
);
REVOKE ALL ON platform_admin_reserved_org FROM arcompt_app;
DROP POLICY IF EXISTS platform_admin_internal ON platform_admin;
DROP POLICY IF EXISTS platform_admin_audit_internal ON platform_admin_audit;
CREATE POLICY platform_admin_internal ON platform_admin
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass));
CREATE POLICY platform_admin_audit_internal ON platform_admin_audit
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass));
UPDATE platform_admin SET active = false
 WHERE NOT EXISTS (SELECT 1 FROM platform_admin_reserved_org r JOIN app_user u ON u.organization_id = r.organization_id WHERE u.id = platform_admin.user_id);
ALTER TABLE platform_admin_audit DROP CONSTRAINT IF EXISTS platform_admin_audit_actor_user_id_fkey;
ALTER TABLE platform_admin_audit ADD CONSTRAINT platform_admin_audit_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES app_user(id) ON DELETE RESTRICT;