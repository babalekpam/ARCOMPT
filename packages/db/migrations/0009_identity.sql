-- ---------------------------------------------------------------------------
-- 0009 — Identité et autorisation côté ARCOMPT.
--
-- Keycloak authentifie (il fournit un `sub` vérifié) ; ARCOMPT autorise. Les
-- rôles et les dossiers accessibles viennent désormais de `company_member`,
-- plus d'un attribut recopié dans le jeton : une modification faite par le
-- portail (rôle changé, membre retiré, dossier créé) prend effet à la requête
-- suivante, sans toucher à Keycloak.
--
-- `app_user` et `company_member` sont en FORCE ROW LEVEL SECURITY : au moment
-- où l'on résout l'identité, aucun contexte tenant n'existe encore (c'est
-- justement ce que l'on cherche à établir). D'où le motif SECURITY DEFINER
-- déjà employé par organization_of_company() et invitation_by_token_hash() :
-- la fonction ne prend en entrée qu'un secret vérifié (ici le `sub` signé par
-- Keycloak) et ne révèle que les droits de cet utilisateur précis.
-- ---------------------------------------------------------------------------

-- Une ligne par appartenance ; les colonnes d'en-tête (utilisateur,
-- organisation, suspension, exigence MFA) sont répétées. La LEFT JOIN garantit
-- qu'un utilisateur connu mais sans aucune appartenance est tout de même
-- résolu : l'API peut alors le refuser avec un motif explicite plutôt qu'un
-- « utilisateur inconnu » trompeur.
CREATE OR REPLACE FUNCTION auth_resolve_identity(p_sub text)
RETURNS TABLE (user_id uuid, organization_id uuid, suspended_at timestamptz, mfa_required boolean, company_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.organization_id, u.suspended_at, o.mfa_required, m.company_id, m.role
    FROM app_user u
    JOIN organization o ON o.id = u.organization_id
    -- Le dossier doit appartenir à l'organisation de l'utilisateur : une ligne
    -- d'appartenance orpheline ne donne aucun droit, mais ne fait pas non plus
    -- disparaître l'utilisateur (la jointure reste externe).
    LEFT JOIN (company_member m JOIN company c ON c.id = m.company_id) ON m.user_id = u.id AND c.organization_id = u.organization_id
   WHERE u.keycloak_sub = p_sub
   ORDER BY m.company_id
$$;
REVOKE ALL ON FUNCTION auth_resolve_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_identity(text) TO arcompt_app;

-- ---------------------------------------------------------------------------
-- Rattachement au premier accès.
--
-- `app_user.keycloak_sub` est NULL tant qu'un compte n'a jamais été relié au
-- fournisseur d'identité : c'est le cas de tout utilisateur créé par le portail
-- (invitation) ou par le seed. Sans rattachement automatique, basculer en OIDC
-- refuserait tout le monde jusqu'à ce qu'un administrateur écrive un UPDATE à
-- la main pour chaque utilisateur — exactement l'onboarding manuel que cette
-- migration supprime.
--
-- Le rattachement se fait sur l'adresse de courriel, et il est délibérément
-- étroit :
--   * l'appelant n'invoque cette fonction que si le jeton porte
--     `email_verified` — une adresse non vérifiée laisserait prendre le compte
--     d'autrui en s'inscrivant avec son adresse ;
--   * un compte déjà rattaché n'est jamais réécrit (`keycloak_sub IS NULL`) ;
--   * un `sub` déjà connu ne peut pas en revendiquer un second ;
--   * l'ambiguïté est refusée : s'il existe plusieurs comptes non rattachés
--     pour la même adresse, on ne devine pas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_link_subject(p_sub text, p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id    uuid;
  v_count integer;
BEGIN
  IF p_sub IS NULL OR btrim(p_sub) = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN NULL;
  END IF;

  -- Ce sujet est-il déjà rattaché à un compte ? Alors il n'en réclame pas un autre.
  IF EXISTS (SELECT 1 FROM app_user WHERE keycloak_sub = p_sub) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_count
    FROM app_user
   WHERE lower(email) = lower(btrim(p_email)) AND keycloak_sub IS NULL;

  IF v_count <> 1 THEN
    RETURN NULL; -- inconnu, déjà rattaché, ou ambigu : on ne devine pas
  END IF;

  UPDATE app_user
     SET keycloak_sub = p_sub
   WHERE lower(email) = lower(btrim(p_email)) AND keycloak_sub IS NULL
   RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION auth_link_subject(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_link_subject(text, text) TO arcompt_app;

-- Dernière activité : alimentée par le middleware d'authentification, au mieux.
-- Sans elle, `last_active_at` reste NULL et suspendInactiveAccounts() suspend
-- sur la seule date de création du compte.
CREATE OR REPLACE FUNCTION auth_touch_last_active(p_user uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET last_active_at = now() WHERE id = p_user
$$;
REVOKE ALL ON FUNCTION auth_touch_last_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_touch_last_active(uuid) TO arcompt_app;
