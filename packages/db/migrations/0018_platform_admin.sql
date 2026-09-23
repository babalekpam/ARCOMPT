-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
--
-- Platform support administrators are deliberately separate from
-- company_member.  This table never grants an OWNER role and is only usable
-- through the narrowly scoped SECURITY DEFINER functions below.

CREATE TABLE platform_admin (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE RESTRICT,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_admin_reserved_org (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  organization_id uuid NOT NULL UNIQUE REFERENCES organization(id) ON DELETE RESTRICT
);
REVOKE ALL ON platform_admin_reserved_org FROM arcompt_app;

CREATE TABLE platform_admin_audit (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  subject_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  operator_label  text,
  database_role   text NOT NULL DEFAULT current_user,
  at              timestamptz NOT NULL DEFAULT now(),
  company_id      uuid REFERENCES company(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organization(id) ON DELETE RESTRICT,
  method          text NOT NULL CHECK (btrim(method) <> ''),
  path            text NOT NULL CHECK (btrim(path) <> ''),
  event           text NOT NULL CHECK (event IN ('GRANT', 'REVOKE', 'ACCESS')),
  reason          text
);
CREATE INDEX platform_admin_audit_at_idx ON platform_admin_audit(at, id);
CREATE TRIGGER platform_admin_audit_immutable
  BEFORE UPDATE OR DELETE ON platform_admin_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE platform_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit FORCE ROW LEVEL SECURITY;
-- FORCE RLS also applies to a SECURITY DEFINER owned by a non-superuser.  The
-- application role has no table privileges, while this policy lets the
-- migration/function owner perform the narrowly defined internal work.
CREATE POLICY platform_admin_internal ON platform_admin
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin'::regclass));
CREATE POLICY platform_admin_audit_internal ON platform_admin_audit
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'platform_admin_audit'::regclass));
REVOKE ALL ON platform_admin FROM arcompt_app;
REVOKE ALL ON platform_admin_audit FROM arcompt_app;

CREATE OR REPLACE FUNCTION platform_admin_identity(p_sub text)
RETURNS TABLE(user_id uuid, suspended_at timestamptz, locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.suspended_at, u.locale
    FROM platform_admin pa
    JOIN app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform_admin_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_identity(text) TO arcompt_app;

CREATE OR REPLACE FUNCTION platform_admin_company(p_sub text, p_company uuid)
RETURNS TABLE(company_id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.organization_id
    FROM platform_admin pa
    JOIN app_user u ON u.id = pa.user_id
    JOIN company c ON c.id = p_company
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
$$;
REVOKE ALL ON FUNCTION platform_admin_company(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_company(text, uuid) TO arcompt_app;

CREATE OR REPLACE FUNCTION platform_admin_companies(p_sub text)
RETURNS TABLE(company_id uuid, company_name text, organization_id uuid, organization_name text, country_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, c.organization_id, o.name, c.country_code::text
    FROM platform_admin pa
    JOIN app_user u ON u.id = pa.user_id
    JOIN company c ON true
    JOIN organization o ON o.id = c.organization_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL
   ORDER BY o.name, c.name, c.id
$$;
REVOKE ALL ON FUNCTION platform_admin_companies(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_companies(text) TO arcompt_app;

CREATE OR REPLACE FUNCTION platform_admin_record_access(
  p_sub text, p_company uuid, p_method text, p_path text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid;
  v_org uuid;
BEGIN
  IF p_method IS NULL OR btrim(p_method) = '' OR p_path IS NULL OR btrim(p_path) = '' THEN
    RAISE EXCEPTION 'ARCOMPT: audit method and path are required' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor
    FROM platform_admin pa JOIN app_user u ON u.id = pa.user_id
   WHERE pa.active AND u.keycloak_sub = p_sub AND u.suspended_at IS NULL;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'ARCOMPT: platform admin inactive or unknown' USING ERRCODE = '28000';
  END IF;
  IF p_company IS NOT NULL THEN
    SELECT c.organization_id INTO v_org FROM company c WHERE c.id = p_company;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'ARCOMPT: company not found' USING ERRCODE = '23503';
    END IF;
  END IF;
  INSERT INTO platform_admin_audit(actor_user_id, company_id, organization_id, method, path, event)
  VALUES (v_actor, p_company, v_org, upper(btrim(p_method)), btrim(p_path), 'ACCESS');
END;
$$;
REVOKE ALL ON FUNCTION platform_admin_record_access(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_record_access(text, uuid, text, text) TO arcompt_app;