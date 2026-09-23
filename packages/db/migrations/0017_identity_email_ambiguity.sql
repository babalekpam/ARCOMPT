-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
--
-- Une adresse déjà liée à un sujet et une seconde ligne non liée portant la
-- même adresse étaient précédemment considérées non ambiguës. Cela aurait
-- permis à un autre sujet OIDC possédant cette adresse de réclamer la seconde
-- ligne. Refuser tout doublon, y compris déjà lié, sans réécrire les comptes.
CREATE OR REPLACE FUNCTION auth_link_subject(p_sub text, p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_linked uuid;
  v_count integer;
BEGIN
  IF p_sub IS NULL OR btrim(p_sub) = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN NULL;
  END IF;

  -- Sérialise deux premiers rattachements de la même adresse.
  PERFORM pg_advisory_xact_lock(hashtext(lower(btrim(p_email))));
  IF EXISTS (SELECT 1 FROM app_user WHERE keycloak_sub = p_sub) THEN
    RETURN NULL;
  END IF;
  SELECT count(*), max(id::text)::uuid INTO v_count, v_id
    FROM app_user WHERE lower(email) = lower(btrim(p_email));
  IF v_count <> 1 THEN
    RETURN NULL;
  END IF;
  UPDATE app_user SET keycloak_sub = p_sub
    WHERE id = v_id AND keycloak_sub IS NULL
    RETURNING id INTO v_linked;
  RETURN v_linked;
END;
$$;
REVOKE ALL ON FUNCTION auth_link_subject(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_link_subject(text, text) TO arcompt_app;