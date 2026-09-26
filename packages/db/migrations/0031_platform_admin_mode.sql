-- A login keeps its customer app_user. The administrative principal is a
-- different app_user in the reserved organization, never customer-owned.
CREATE TABLE platform_admin_binding (
  clerk_sub text PRIMARY KEY CHECK (length(clerk_sub) BETWEEN 1 AND 256),
  user_id uuid NOT NULL UNIQUE REFERENCES platform_admin(user_id) ON DELETE RESTRICT
);
CREATE TABLE platform_admin_mode (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  clerk_sub text NOT NULL REFERENCES platform_admin_binding(clerk_sub) ON DELETE CASCADE,
  clerk_sid text NOT NULL,
  proof_hash text NOT NULL REFERENCES app_mfa_proof(proof_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE platform_admin_audit ADD COLUMN clerk_sid text;
ALTER TABLE platform_admin_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_mode ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_mode FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_binding_internal ON platform_admin_binding
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='platform_admin_binding'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='platform_admin_binding'::regclass));
CREATE POLICY platform_admin_mode_internal ON platform_admin_mode
  USING (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='platform_admin_mode'::regclass))
  WITH CHECK (current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='platform_admin_mode'::regclass));
REVOKE ALL ON platform_admin_binding, platform_admin_mode FROM PUBLIC, arcompt_app;

CREATE FUNCTION platform_mode_eligible(p_sub text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.platform_admin_binding b
    JOIN public.platform_admin a ON a.user_id=b.user_id AND a.active
    JOIN public.app_user u ON u.id=a.user_id AND u.suspended_at IS NULL AND u.keycloak_sub IS NULL
    JOIN public.platform_admin_reserved_org r ON r.organization_id=u.organization_id
    WHERE b.clerk_sub=p_sub AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.organization_id=r.organization_id))
$$;
CREATE FUNCTION platform_mode_identity(p_sub text,p_sid text,p_hash text,p_proof text)
RETURNS TABLE(user_id uuid,suspended_at timestamptz,locale text,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT u.id,u.suspended_at,u.locale,least(m.expires_at,p.expires_at)
    FROM public.platform_admin_mode m
    JOIN public.platform_admin_binding b ON b.clerk_sub=m.clerk_sub
    JOIN public.platform_admin a ON a.user_id=b.user_id AND a.active
    JOIN public.app_user u ON u.id=a.user_id AND u.suspended_at IS NULL AND u.keycloak_sub IS NULL
    JOIN public.platform_admin_reserved_org r ON r.organization_id=u.organization_id
    JOIN public.app_mfa_proof p ON p.proof_hash=m.proof_hash AND p.clerk_sub=m.clerk_sub AND p.clerk_sid=m.clerk_sid
    JOIN public.app_mfa_factor f ON f.clerk_sub=m.clerk_sub AND f.enabled_at IS NOT NULL
    WHERE m.clerk_sub=p_sub AND m.clerk_sid=p_sid AND m.token_hash=p_hash AND p.proof_hash=p_proof
      AND m.expires_at>now() AND p.expires_at>now()
      AND NOT EXISTS(SELECT 1 FROM public.company c WHERE c.organization_id=r.organization_id)
$$;
CREATE FUNCTION platform_mode_activate(p_sub text,p_sid text,p_proof text,p_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; until_at timestamptz;
BEGIN
  -- Serializes activation/deactivation for one subject and session.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sub || ':' || p_sid, 3131));
  IF NOT public.platform_mode_eligible(p_sub) THEN RETURN NULL; END IF;
  SELECT b.user_id INTO actor FROM public.platform_admin_binding b
    JOIN public.platform_admin a ON a.user_id=b.user_id WHERE b.clerk_sub=p_sub AND a.active FOR SHARE OF a,b;
  IF actor IS NULL THEN RETURN NULL; END IF;
  SELECT least(p.expires_at,clock_timestamp()+interval '15 minutes') INTO until_at
    FROM public.app_mfa_proof p JOIN public.app_mfa_factor f ON f.clerk_sub=p.clerk_sub
    WHERE p.proof_hash=p_proof AND p.clerk_sub=p_sub AND p.clerk_sid=p_sid
      AND p.expires_at>clock_timestamp() AND f.enabled_at IS NOT NULL FOR SHARE OF p,f;
  IF until_at IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.platform_admin_mode WHERE expires_at<=clock_timestamp() OR (clerk_sub=p_sub AND clerk_sid=p_sid);
  INSERT INTO public.platform_admin_mode VALUES(p_hash,p_sub,p_sid,p_proof,until_at);
  INSERT INTO public.platform_admin_audit(actor_user_id,method,path,event,reason,clerk_sid)
    VALUES(actor,'POST','/security/admin-mode/activate','ACCESS','ADMIN_MODE_ACTIVATE',p_sid);
  RETURN until_at;
END $$;
CREATE FUNCTION platform_mode_deactivate(p_sub text,p_sid text,p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; removed boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sub || ':' || p_sid, 3131));
  SELECT user_id INTO actor FROM public.platform_admin_binding WHERE clerk_sub=p_sub;
  DELETE FROM public.platform_admin_mode WHERE clerk_sub=p_sub AND clerk_sid=p_sid AND token_hash=p_hash;
  removed := FOUND;
  IF removed AND actor IS NOT NULL THEN
    INSERT INTO public.platform_admin_audit(actor_user_id,method,path,event,reason,clerk_sid)
      VALUES(actor,'POST','/security/admin-mode/deactivate','ACCESS','ADMIN_MODE_DEACTIVATE',p_sid);
  END IF;
END $$;
CREATE FUNCTION platform_mode_companies(p_sub text,p_sid text,p_hash text,p_proof text)
RETURNS TABLE(company_id uuid,company_name text,organization_id uuid,organization_name text,country_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT c.id,c.name,c.organization_id,o.name,c.country_code::text
    FROM public.platform_mode_identity(p_sub,p_sid,p_hash,p_proof) a
    JOIN public.company c ON true JOIN public.organization o ON o.id=c.organization_id ORDER BY o.name,c.name,c.id
$$;
CREATE FUNCTION platform_mode_record_access(p_sub text,p_sid text,p_hash text,p_proof text,p_company uuid,p_method text,p_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; org uuid;
BEGIN
  SELECT user_id INTO actor FROM public.platform_mode_identity(p_sub,p_sid,p_hash,p_proof);
  IF actor IS NULL THEN RAISE EXCEPTION 'ARCOMPT: invalid admin mode' USING ERRCODE='28000'; END IF;
  IF p_company IS NOT NULL THEN
    SELECT organization_id INTO org FROM public.company WHERE id=p_company;
    IF org IS NULL THEN RAISE EXCEPTION 'ARCOMPT: company not found' USING ERRCODE='23503'; END IF;
  END IF;
  INSERT INTO public.platform_admin_audit(actor_user_id,company_id,organization_id,method,path,event,clerk_sid)
    VALUES(actor,p_company,org,p_method,p_path,'ACCESS',p_sid);
END $$;
REVOKE ALL ON FUNCTION platform_mode_eligible(text),platform_mode_identity(text,text,text,text),
  platform_mode_activate(text,text,text,text),platform_mode_deactivate(text,text,text),
  platform_mode_companies(text,text,text,text),platform_mode_record_access(text,text,text,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_mode_eligible(text),platform_mode_identity(text,text,text,text),
  platform_mode_activate(text,text,text,text),platform_mode_deactivate(text,text,text),
  platform_mode_companies(text,text,text,text),platform_mode_record_access(text,text,text,text,uuid,text,text) TO arcompt_app;

-- Email-based onboarding must never claim an unlinked internal principal.
CREATE OR REPLACE FUNCTION public.auth_link_subject(p_sub text,p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid; v_linked uuid; v_count integer;
BEGIN
  IF p_sub IS NULL OR btrim(p_sub)='' OR p_email IS NULL OR btrim(p_email)='' THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(lower(btrim(p_email))));
  IF EXISTS(SELECT 1 FROM public.app_user WHERE keycloak_sub=p_sub) THEN RETURN NULL; END IF;
  SELECT count(*),max(u.id::text)::uuid INTO v_count,v_id FROM public.app_user u
    WHERE lower(u.email)=lower(btrim(p_email))
      AND NOT EXISTS(SELECT 1 FROM public.platform_admin_reserved_org r WHERE r.organization_id=u.organization_id);
  IF v_count<>1 THEN RETURN NULL; END IF;
  UPDATE public.app_user SET keycloak_sub=p_sub WHERE id=v_id AND keycloak_sub IS NULL RETURNING id INTO v_linked;
  RETURN v_linked;
END $$;