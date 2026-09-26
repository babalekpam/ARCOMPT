-- Privileged operators alone can preapprove. Runtime may only consume an
-- exact verified identity with a current session-bound ARCOMPT MFA proof.
CREATE TABLE platform_admin_preapproval (
  clerk_sub text PRIMARY KEY CHECK (length(clerk_sub) BETWEEN 1 AND 256),
  expected_email text NOT NULL CHECK (expected_email = lower(btrim(expected_email)) AND length(expected_email) BETWEEN 3 AND 320),
  expires_at timestamptz NOT NULL,
  operator_label text NOT NULL CHECK (btrim(operator_label) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
ALTER TABLE platform_admin_preapproval ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_preapproval FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_preapproval_internal ON platform_admin_preapproval
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.platform_admin_preapproval'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.platform_admin_preapproval'::regclass));
REVOKE ALL ON platform_admin_preapproval FROM PUBLIC, arcompt_app;

CREATE FUNCTION platform_mode_approved(p_sub text,p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.platform_admin_preapproval a
    JOIN public.app_user u ON u.keycloak_sub=a.clerk_sub AND u.suspended_at IS NULL
    WHERE a.clerk_sub=p_sub AND a.expected_email=lower(btrim(p_email))
      AND a.consumed_at IS NULL AND a.revoked_at IS NULL AND a.expires_at>now()
      AND NOT EXISTS(SELECT 1 FROM public.platform_admin_binding b WHERE b.clerk_sub=p_sub)
      AND NOT EXISTS(SELECT 1 FROM public.platform_admin pa WHERE pa.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM public.platform_admin_reserved_org r WHERE r.organization_id=u.organization_id))
$$;

CREATE FUNCTION platform_mode_activate_approved(p_sub text,p_email text,p_sid text,p_proof text,p_hash text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE approval public.platform_admin_preapproval%ROWTYPE; org uuid; actor uuid; until_at timestamptz;
BEGIN
  IF p_sub IS NULL OR p_sid IS NULL OR length(p_sid) NOT BETWEEN 1 AND 256
    OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
    OR p_proof IS NULL OR p_proof !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  -- Same provisioning lock/order as the maintenance CLI. Existing or revoked
  -- bindings are NEVER re-provisioned by a pending approval.
  PERFORM pg_advisory_xact_lock(19021,18);
  IF EXISTS(SELECT 1 FROM public.platform_admin_binding WHERE clerk_sub=p_sub) THEN
    RETURN public.platform_mode_activate(p_sub,p_sid,p_proof,p_hash);
  END IF;
  LOCK TABLE public.app_user,public.company IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO approval FROM public.platform_admin_preapproval WHERE clerk_sub=p_sub FOR UPDATE;
  IF NOT FOUND OR approval.expires_at<=clock_timestamp()
    OR NOT public.platform_mode_approved(p_sub,p_email) THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.app_mfa_proof p JOIN public.app_mfa_factor f ON f.clerk_sub=p.clerk_sub
    WHERE p.proof_hash=p_proof AND p.clerk_sub=p_sub AND p.clerk_sid=p_sid
      AND p.expires_at>clock_timestamp() AND f.enabled_at IS NOT NULL FOR SHARE OF p,f;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT organization_id INTO org FROM public.platform_admin_reserved_org FOR UPDATE;
  IF org IS NOT NULL AND EXISTS(SELECT 1 FROM public.company WHERE organization_id=org) THEN RETURN NULL; END IF;
  IF org IS NULL THEN
    -- Do not adopt a customer-controlled organization with the reserved name.
    IF EXISTS(SELECT 1 FROM public.organization WHERE name='__ARCOMPT_PLATFORM_INTERNAL__') THEN RETURN NULL; END IF;
    INSERT INTO public.organization(name,kind,plan) VALUES('__ARCOMPT_PLATFORM_INTERNAL__','GROUP','TRIAL') RETURNING id INTO org;
    INSERT INTO public.platform_admin_reserved_org(organization_id) VALUES(org);
  END IF;
  INSERT INTO public.app_user(organization_id,keycloak_sub,email,display_name)
    VALUES(org,NULL,approval.expected_email,approval.operator_label) RETURNING id INTO actor;
  INSERT INTO public.platform_admin(user_id,active) VALUES(actor,true);
  INSERT INTO public.platform_admin_binding(clerk_sub,user_id) VALUES(p_sub,actor);
  UPDATE public.platform_admin_preapproval SET consumed_at=clock_timestamp() WHERE clerk_sub=p_sub;
  INSERT INTO public.platform_admin_audit(subject_user_id,organization_id,method,path,event,reason,operator_label,database_role,clerk_sid)
    VALUES(actor,org,'POST','/security/admin-mode/activate','GRANT',approval.reason,approval.operator_label,session_user,p_sid);
  until_at := public.platform_mode_activate(p_sub,p_sid,p_proof,p_hash);
  -- Exception rolls back the entire statement, including the grant, if a proof
  -- expires during provisioning. Invalid mode parameters cannot partially grant.
  IF until_at IS NULL OR approval.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'ARCOMPT: activation proof or approval expired' USING ERRCODE='28000';
  END IF;
  RETURN until_at;
END $$;
REVOKE ALL ON FUNCTION platform_mode_approved(text,text),platform_mode_activate_approved(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_mode_approved(text,text),platform_mode_activate_approved(text,text,text,text,text) TO arcompt_app;

CREATE FUNCTION platform_mode_revoke_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT NEW.active THEN
    DELETE FROM public.platform_admin_mode WHERE clerk_sub IN (SELECT clerk_sub FROM public.platform_admin_binding WHERE user_id=NEW.user_id);
    UPDATE public.platform_admin_preapproval SET revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE clerk_sub IN (SELECT clerk_sub FROM public.platform_admin_binding WHERE user_id=NEW.user_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform_mode_revoke_cleanup() FROM PUBLIC,arcompt_app;
CREATE TRIGGER platform_mode_revoke_cleanup AFTER UPDATE OF active ON platform_admin
  FOR EACH ROW EXECUTE FUNCTION platform_mode_revoke_cleanup();