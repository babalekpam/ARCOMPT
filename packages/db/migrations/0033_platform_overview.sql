-- Aggregate platform discovery without granting runtime cross-tenant reads.
CREATE FUNCTION public.platform_overview(p_sub text,p_sid text,p_token text,p_proof text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF p_sid IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.platform_mode_identity(p_sub,p_sid,p_token,p_proof)) THEN
      RAISE EXCEPTION 'Platform mode required' USING ERRCODE='42501';
    END IF;
    PERFORM public.platform_mode_record_access(p_sub,p_sid,p_token,p_proof,NULL,'GET','/platform/overview');
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.platform_admin_identity(p_sub) WHERE suspended_at IS NULL) THEN
      RAISE EXCEPTION 'Platform administrator required' USING ERRCODE='42501';
    END IF;
    PERFORM public.platform_admin_record_access(p_sub,NULL,'GET','/platform/overview');
  END IF;
  WITH organizations AS (
    SELECT o.id,o.name,o.kind,o.plan FROM public.organization o
    WHERE NOT EXISTS(SELECT 1 FROM public.platform_admin_reserved_org r WHERE r.organization_id=o.id)
  ), counts AS (
    SELECT o.*,
      (SELECT count(*) FROM public.app_user u WHERE u.organization_id=o.id) AS users,
      (SELECT count(*) FROM public.app_user u WHERE u.organization_id=o.id AND u.suspended_at IS NULL) AS active_users,
      (SELECT count(*) FROM public.app_user u WHERE u.organization_id=o.id AND u.suspended_at IS NOT NULL) AS suspended_users,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'organizationId',o.id,
        'organizationName',o.name,'countryCode',c.country_code) ORDER BY c.name,c.id)
        FROM public.company c WHERE c.organization_id=o.id),'[]'::jsonb) AS companies
    FROM organizations o
  )
  SELECT jsonb_build_object(
    'totals',jsonb_build_object('organizations',count(*),'companies',COALESCE(sum(jsonb_array_length(companies)),0),
      'users',COALESCE(sum(users),0),'activeUsers',COALESCE(sum(active_users),0),'suspendedUsers',COALESCE(sum(suspended_users),0)),
    'organizations',COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'kind',kind,'plan',plan,
      'users',users,'activeUsers',active_users,'suspendedUsers',suspended_users,'companies',companies) ORDER BY name,id),'[]'::jsonb))
  INTO result FROM counts;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.platform_overview(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_overview(text,text,text,text) TO arcompt_app;
