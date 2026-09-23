-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- ARCOMPT — langue du dossier (phase 0016)
--
-- La règle de langue (packages/render/src/locale.ts) range quatre sources :
-- demande explicite, destinataire, DOSSIER, opérateur. La troisième n'existait
-- pas : `app_user.locale` est là depuis 0001, `company` n'avait rien. La règle
-- sautait donc silencieusement un échelon et tombait sur la langue de l'écran
-- du comptable pour des documents qui sont archivés et déposés.
--
-- Pourquoi le dossier et non l'opérateur, pour un document sans destinataire :
-- une balance, un grand livre, une liasse sont classés et présentés à
-- l'administration et au commissaire aux comptes. La langue attendue est celle
-- sous laquelle le dossier est tenu, pas celle de l'écran de la personne qui a
-- cliqué — laquelle peut changer d'un jour à l'autre sans rien dire du dossier.
--
-- Défaut 'fr' : le SYSCOHADA est un référentiel francophone, et un dossier dont
-- personne n'a renseigné la langue est un dossier français. C'est un choix
-- explicite, pas un héritage de la locale du serveur.
--
-- LA LANGUE DU DESTINATAIRE, elle, n'a besoin d'AUCUNE colonne : `partner.contact`
-- est déjà un jsonb qui porte `email`, `phone` et `whatsapp`. La langue s'y
-- range de la même façon, sous la clé `locale` :
--     {"email": "…", "phone": "…", "locale": "en"}
-- Ajouter une colonne pour une préférence d'affichage aurait figé dans le schéma
-- ce qui appartient à la fiche de contact.

ALTER TABLE company ADD COLUMN locale text NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr', 'en'));

COMMENT ON COLUMN company.locale IS
  'Langue de tenue du dossier : celle des documents archivés et déposés. Le destinataire (partner.contact.locale) la précède pour une pièce qui lui est adressée.';

-- ---------------------------------------------------------------------------
-- La langue de l'opérateur doit remonter jusqu'à l'API.
--
-- `app_user.locale` existe depuis 0001 mais ne quittait jamais la base :
-- `auth_resolve_identity` ne la renvoyait pas, donc `resolveLocale` ne pouvait
-- pas la consulter et le dernier échelon de la précédence était mort lui aussi.
-- Une seule requête la rapporte, au moment où l'identité est déjà lue.
-- ---------------------------------------------------------------------------
-- `CREATE OR REPLACE` ne sait pas changer le type de retour d'une fonction :
-- l'ancienne signature doit partir d'abord. Rien ne dépend de cette fonction
-- côté base (aucune vue, aucun trigger) : seule l'API l'appelle.
DROP FUNCTION IF EXISTS auth_resolve_identity(text);

CREATE FUNCTION auth_resolve_identity(p_sub text)
RETURNS TABLE (user_id uuid, organization_id uuid, suspended_at timestamptz, mfa_required boolean, locale text, company_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.organization_id, u.suspended_at, o.mfa_required, u.locale, m.company_id, m.role
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
