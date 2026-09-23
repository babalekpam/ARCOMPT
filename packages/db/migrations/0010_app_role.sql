-- ---------------------------------------------------------------------------
-- 0010 — Droits du rôle applicatif : fermer les trous ouverts par
-- ALTER DEFAULT PRIVILEGES.
--
-- `0001_core.sql` se termine par :
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO arcompt_app;
--
-- Autrement dit : toute table créée ensuite par le compte de migration donne
-- d'office les quatre droits d'écriture au rôle applicatif. Une migration
-- ultérieure qui accorde volontairement moins n'enlève rien — le GRANT
-- restreint est redondant, pas restrictif. Trois interdits énoncés par les
-- migrations elles-mêmes étaient donc inopérants :
--
--   * payroll_tenant_key : « jamais de suppression de clé par l'application »
--     (0005). Le rôle applicatif pouvait DELETE la clé de données enveloppée
--     d'un dossier — les colonnes *_enc de la paie deviennent alors
--     définitivement indéchiffrables : perte de données irréversible, sans
--     trigger pour l'arrêter ;
--   * admin_access_log : journal d'accès administrateur « en insertion seule »
--     (0008). Le trigger admin_access_log_guard refusait déjà le DELETE, mais
--     le droit SQL, lui, était accordé : le garde-fou tenait à un seul verrou ;
--   * whatsapp_webhook_receipt : anti-rejeu du webhook (0007), accordé en
--     SELECT/INSERT/DELETE. L'UPDATE reçu en prime permet de réécrire un
--     accusé de réception, donc de rejouer un message déjà traité.
--
-- S'y ajoute schema_migration, créée par le lanceur de migrations avant 0001 et
-- donc balayée par son « GRANT … ON ALL TABLES » : le rôle applicatif pouvait
-- réécrire l'historique des migrations.
--
-- Cette migration ne crée AUCUN rôle de connexion : un mot de passe n'a pas sa
-- place dans un fichier versionné. Le rôle de connexion membre de arcompt_app
-- est créé par `packages/db/src/provision.ts` (script
-- `scripts/provision-app-role.ts`), une fois par base.
-- ---------------------------------------------------------------------------

-- Filet : sur une base restaurée partiellement, le rôle de groupe doit exister.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app') THEN
    CREATE ROLE arcompt_app NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Supprimer les privilèges par défaut sur les tables.
--
-- Désormais, une nouvelle table n'accorde rien tant qu'une migration ne le dit
-- pas explicitement. L'oubli devient visible (« permission denied » au premier
-- appel) au lieu d'être silencieusement trop permissif. Les droits déjà
-- accordés aux tables existantes ne bougent pas.
--
-- La révocation doit être exécutée par le rôle qui a posé le défaut ; on
-- balaie donc pg_default_acl, en ne traitant que les rôles dont le compte de
-- migration est membre (sinon la commande échouerait).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT pg_get_userbyid(d.defaclrole) AS owner_role
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public'
       AND d.defaclobjtype = 'r'
       AND array_to_string(d.defaclacl, ',') LIKE '%arcompt_app=%'
  LOOP
    IF pg_has_role(current_user, r.owner_role, 'USAGE') THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM arcompt_app', r.owner_role);
    ELSE
      RAISE WARNING 'ARCOMPT: privilèges par défaut posés par % non révocables depuis % : à traiter à la main', r.owner_role, current_user;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Retirer les droits obtenus par défaut et jamais voulus.
-- ---------------------------------------------------------------------------

-- Clé de chiffrement de la paie : lecture, création et retraite d'une version
-- (rotation) ; jamais de suppression.
REVOKE DELETE ON payroll_tenant_key FROM arcompt_app;

-- Journal des accès administrateur : insertion, puis seules les colonnes de
-- notification changent (trigger admin_access_log_guard). Pas de suppression.
REVOKE DELETE ON admin_access_log FROM arcompt_app;

-- Anti-rejeu WhatsApp : on constate, on insère, on purge. On ne réécrit pas.
REVOKE UPDATE ON whatsapp_webhook_receipt FROM arcompt_app;

-- Historique des migrations : affaire du compte de migration, pas de l'application.
REVOKE ALL ON schema_migration FROM arcompt_app;

-- ---------------------------------------------------------------------------
-- 3. Réaffirmer les interdits déjà posés ailleurs.
--
-- Ils tiennent aujourd'hui parce que le REVOKE suivait le GRANT dans la même
-- migration. Les répéter ici rend le modèle lisible d'un seul endroit et rend
-- la migration idempotente vis-à-vis d'une base qui aurait dérivé.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON audit_log FROM arcompt_app;             -- piste d'audit : insertion seule
REVOKE INSERT, UPDATE, DELETE ON account_balance FROM arcompt_app; -- soldes tenus par le trigger SECURITY DEFINER
REVOKE UPDATE, DELETE ON ai_call_log FROM arcompt_app;           -- journal des appels IA : insertion seule
REVOKE INSERT, UPDATE, DELETE ON subscription_plan FROM arcompt_app; -- catalogue d'abonnements : lecture seule

-- ---------------------------------------------------------------------------
-- 4. Schéma : pas de DDL depuis le rôle applicatif.
--
-- PostgreSQL ≥ 15 ne donne plus CREATE sur public à PUBLIC ; sur une base
-- créée avant, ou restaurée depuis une version antérieure, le rôle applicatif
-- pourrait créer ses propres objets (y compris masquer une fonction du
-- search_path). On le retire explicitement, en conservant USAGE.
-- ---------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO arcompt_app;

-- Fonction de trigger SECURITY DEFINER : elle ne doit être appelable que par
-- le trigger qui la porte (les droits d'un trigger sont vérifiés à sa
-- création), jamais directement par un rôle quelconque.
REVOKE ALL ON FUNCTION journal_entry_update_balances() FROM PUBLIC;
