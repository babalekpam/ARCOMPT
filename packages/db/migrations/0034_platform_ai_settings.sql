CREATE TABLE public.platform_ai_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision integer NOT NULL DEFAULT 0,
  payload_cipher text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_ai_settings(singleton) VALUES(true);
ALTER TABLE public.platform_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_ai_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ai_settings_internal ON public.platform_ai_settings
 USING(current_user=(SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.platform_ai_settings'::regclass))
 WITH CHECK(current_user=(SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.platform_ai_settings'::regclass));
REVOKE ALL ON public.platform_ai_settings FROM PUBLIC,arcompt_app;
-- Runtime receives ciphertext, never the encryption key from PostgreSQL.
CREATE FUNCTION public.platform_ai_runtime() RETURNS TABLE(revision integer,payload_cipher text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT revision,payload_cipher FROM public.platform_ai_settings WHERE singleton
$$;
CREATE FUNCTION public.platform_ai_save(p_sub text,p_sid text,p_token text,p_proof text,p_revision integer,p_cipher text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_revision integer;
BEGIN
 IF p_sid IS NOT NULL THEN
   PERFORM public.platform_mode_record_access(p_sub,p_sid,p_token,p_proof,NULL,'PUT','/platform/ai');
 ELSE
   PERFORM public.platform_admin_record_access(p_sub,NULL,'PUT','/platform/ai');
 END IF;
 SELECT revision INTO v_revision FROM public.platform_ai_settings WHERE singleton FOR UPDATE;
 IF p_revision IS NULL OR p_revision<>v_revision THEN
   RAISE EXCEPTION 'AI settings revision conflict' USING ERRCODE='40001';
 END IF;
 UPDATE public.platform_ai_settings SET revision=revision+1,payload_cipher=p_cipher,updated_at=clock_timestamp() WHERE singleton RETURNING revision INTO v_revision;
 RETURN v_revision;
END $$;
REVOKE ALL ON FUNCTION public.platform_ai_runtime(),public.platform_ai_save(text,text,text,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_ai_runtime(),public.platform_ai_save(text,text,text,text,integer,text) TO arcompt_app;
