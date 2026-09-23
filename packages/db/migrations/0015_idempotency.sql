-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- ARCOMPT — idempotence générale des créations (phase 0015)
--
-- POURQUOI
-- --------
-- Le mode hors ligne ne se limite plus aux brouillons d'écriture. Un comptable
-- en tournée crée aussi un tiers, un article, un brouillon de facture, un
-- mouvement de stock et photographie des pièces, le tout sans réseau ; la file
-- locale rejoue ces opérations au retour. Un rejeu est, par construction, une
-- requête qui a PEUT-ÊTRE déjà abouti : la réponse s'est perdue en chemin, pas
-- forcément l'écriture. Sans garde, le retour du réseau crée des doublons —
-- deux fois le même client, deux fois le même mouvement de stock.
--
-- `journal_entry.client_id` (0001) réglait ce problème pour les seules
-- écritures, avec une colonne dédiée et un UNIQUE. Ajouter cette colonne à six
-- tables de plus aurait multiplié la même mécanique ; on la sort donc du
-- domaine métier pour en faire un registre commun.
--
-- CE QUI EST CONSERVÉ, ET POURQUOI
-- --------------------------------
-- `request_hash` : empreinte du corps canonique. Le même `client_id` avec un
-- corps DIFFÉRENT n'est pas un rejeu mais une collision (identifiant recyclé,
-- brouillon modifié après un premier envoi) : elle est refusée, jamais servie
-- en silence avec l'ancienne réponse.
--
-- `response` : la réponse rendue au premier appel, renvoyée telle quelle au
-- rejeu. Le client obtient l'identifiant serveur de la ressource qu'il a créée
-- même si sa première réponse s'est perdue — sans quoi la file locale ne
-- saurait pas relier son identifiant local au tiers réellement créé.
--
-- La table ne contient que des réponses de création : identifiants, libellés,
-- états. Aucun montant de paie, aucun identifiant fiscal en clair — les routes
-- concernées ne passent pas par ce registre.
--
-- DEUX CHEMINS, PARCE QUE DEUX FORMES DE ROUTE
-- --------------------------------------------
-- Certaines routes possèdent leur transaction (les tiers écrivent en SQL direct
-- sous `withTenant`) : la ressource et sa trace s'écrivent ensemble, l'état naît
-- `COMPLETED`. D'autres délèguent à un service qui ouvre la sienne (facturation,
-- achats, stock) : impossible d'y partager la transaction sans rendre le service
-- dépendant de l'idempotence. Pour celles-là, la trace est posée AVANT en
-- `PENDING`, puis complétée par la réponse.
--
-- L'état `PENDING` n'est pas un détail : il dit « quelqu'un exécute déjà ce
-- rejeu ». Un second envoi concurrent reçoit 409 et réessaiera, plutôt que de
-- créer le doublon que la trace existe précisément pour empêcher. Si l'opération
-- échoue, la réservation est retirée — un échec ne doit pas condamner
-- l'identifiant.

-- CE QUI N'EST PAS IDEMPOTENT, ET POURQUOI
-- ----------------------------------------
-- La validation d'une écriture, l'émission d'une facture numérotée, un
-- règlement, une déclaration : ces actes portent un numéro légal séquentiel ou
-- un effet externe. Ils exigent un serveur joignable et ne sont pas rejouables
-- depuis une file locale ; voir docs/OFFLINE.md.

CREATE TABLE idempotency_record (
  tenant_id     uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  -- Identifiant fabriqué par le client (UUID v4) au moment de la mise en file.
  client_id     uuid NOT NULL,
  -- Opération logique : 'partner.create', 'product.create', 'stock.movement'…
  -- Le même client_id sur deux opérations différentes est une collision.
  operation     text NOT NULL CHECK (operation ~ '^[a-z]+\.[a-z_]+$'),
  -- sha256 hexadécimal du corps canonique (clés triées).
  request_hash  text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- Ressource créée : type et identifiant, pour relier l'identifiant local au
  -- serveur sans réinterpréter la réponse.
  resource_kind text NOT NULL,
  resource_id   uuid,
  -- PENDING : réservation posée, opération en cours. COMPLETED : réponse connue.
  state         text NOT NULL DEFAULT 'COMPLETED' CHECK (state IN ('PENDING', 'COMPLETED')),
  -- Corps de la réponse servie au premier appel, rendu tel quel au rejeu.
  -- NULL tant que l'état est PENDING.
  response      jsonb,
  status_code   smallint CHECK (status_code BETWEEN 200 AND 299),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,

  PRIMARY KEY (tenant_id, client_id),
  CHECK ((state = 'COMPLETED') = (response IS NOT NULL AND status_code IS NOT NULL AND completed_at IS NOT NULL))
);

-- Réservations abandonnées (processus tué entre la réservation et la réponse) :
-- elles bloqueraient l'identifiant indéfiniment. Le ménage les reprend.
CREATE INDEX idempotency_record_pending_idx ON idempotency_record (created_at) WHERE state = 'PENDING';

-- Purge : un rejeu arrive dans les minutes ou les jours qui suivent, pas dans
-- les mois. L'index sert le ménage périodique (scripts/purge-idempotency.mts).
CREATE INDEX idempotency_record_age_idx ON idempotency_record (created_at);

-- ---------------------------------------------------------------------------
-- Immutabilité. Un registre d'idempotence qui se réécrit ne garantit plus rien :
-- il suffirait de remplacer la réponse conservée pour faire croire à un rejeu
-- réussi. Seule la suppression par purge est permise, et seulement sur les
-- lignes anciennes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idempotency_record_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Seule transition permise : PENDING -> COMPLETED, une fois, sans toucher
    -- à l'identité de la requête. Tout le reste réécrirait une preuve.
    IF OLD.state <> 'PENDING' OR NEW.state <> 'COMPLETED' THEN
      RAISE EXCEPTION 'ARCOMPT: un enregistrement d''idempotence complété est immuable (client_id %)', OLD.client_id
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.client_id <> OLD.client_id
       OR NEW.operation <> OLD.operation OR NEW.request_hash <> OLD.request_hash
       OR NEW.resource_kind <> OLD.resource_kind OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'ARCOMPT: l''identité d''un enregistrement d''idempotence ne se réécrit pas (client_id %)', OLD.client_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Une réservation abandonnée se retire : un échec ne condamne pas
  -- l'identifiant. Une trace complétée, elle, tient sept jours — le temps qu'un
  -- appareil resté hors ligne revienne rejouer.
  IF OLD.state = 'COMPLETED' AND OLD.created_at > now() - interval '7 days' THEN
    RAISE EXCEPTION 'ARCOMPT: suppression interdite avant 7 jours (client_id % du %)', OLD.client_id, OLD.created_at
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER idempotency_record_immutable_trg BEFORE UPDATE OR DELETE ON idempotency_record
  FOR EACH ROW EXECUTE FUNCTION idempotency_record_immutable();

-- ---------------------------------------------------------------------------
-- Isolation par dossier. Un identifiant client tiré par un appareil ne doit
-- jamais servir de sonde sur un autre dossier.
-- ---------------------------------------------------------------------------
ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_record
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- SELECT, INSERT, UPDATE (la seule transition PENDING -> COMPLETED, que le
-- trigger borne) et DELETE (retrait d'une réservation échouée, que le trigger
-- borne aussi : une trace complétée de moins de sept jours ne s'efface pas).
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_record TO arcompt_app;
