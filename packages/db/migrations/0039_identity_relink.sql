-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- Migration 0039 — Réparation d'identité Clerk (cas réel du 2026-10-13) :
-- quand un utilisateur supprime son compte Clerk puis le recrée avec la même
-- adresse, son nouveau sujet ne correspond plus à l'app_user existant et
-- auth_bootstrap_lookup répond EMAIL_LINKED : impasse totale (page
-- « No company access yet », aucun chemin de création de dossier).
-- auth_relink_identity rattache l'unique app_user portant l'adresse au
-- nouveau sujet. L'API ne l'appelle qu'après vérification Clerk de
-- l'adresse (emailVerified) : prouver le contrôle de l'adresse suffit, le
-- même fondement de confiance que le claim initial. Les comptes suspendus
-- et les adresses ambiguës (plusieurs lignes) ne sont jamais rattachés.

CREATE OR REPLACE FUNCTION auth_relink_identity(p_sub text, p_email text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  matches int;
  updated int;
BEGIN
  SELECT count(*) INTO matches
    FROM public.app_user
   WHERE lower(email) = lower(btrim(p_email));
  IF matches <> 1 THEN RETURN false; END IF;
  UPDATE public.app_user
     SET keycloak_sub = p_sub
   WHERE lower(email) = lower(btrim(p_email))
     AND keycloak_sub <> p_sub
     AND suspended_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END $$;
REVOKE ALL ON FUNCTION auth_relink_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_relink_identity(text, text) TO arcompt_app;

INSERT INTO schema_migration (name) VALUES ('0039_identity_relink')
ON CONFLICT (name) DO NOTHING;
