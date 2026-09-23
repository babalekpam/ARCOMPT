-- ARCOMPT — ancrage externe de la chaîne de hash (phase 0013)
--
-- SECURITY.md § 6 et engagement n° 10 : « la chaîne de hash est ancrée hors de
-- la plateforme ». Jusqu'ici le calcul existait (packages/ledger/src/anchoring.ts)
-- mais rien ne le conservait : pas de table, pas d'appelant, un publieur en
-- mémoire. Cette migration apporte la conservation.
--
-- CE QUI EST ANCRÉ, ET POURQUOI
-- -----------------------------
-- Le dépôt tient DEUX chaînes de hash (§ 6 : « chaînage par hash des écritures
-- et du journal d'audit ») :
--   - journal_entry.hash   : une chaîne par journal, sur le contenu comptable ;
--   - audit_log.hash       : une chaîne par dossier, sur les actions.
-- Ancrer les seules écritures — ce que faisait dailyLeaves() — laisserait la
-- piste d'audit hors de la preuve : on pourrait prouver qu'une écriture existait
-- le 3 mars sans rien prouver de QUI l'a validée, ni du déverrouillage de
-- période qui l'a précédée. L'ancre couvre donc les deux : chaque feuille est
-- un hash déjà chaîné, préfixé de son domaine (« ENTRY: » / « AUDIT: »), et la
-- racine de Merkle du jour scelle l'ensemble. Une ancre vide (aucune activité)
-- n'est pas écrite : seuls les jours qui ont produit quelque chose sont ancrés.
--
-- L'ancre elle-même est chaînée (prev_anchor_hash) : retirer une journée du
-- registre publié casse la chaîne des ancres, pas seulement une ancre.

CREATE TABLE ledger_anchor (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  -- Jour couvert, en UTC (date de validation des écritures, date des lignes d'audit).
  day               date NOT NULL,
  -- Racine de Merkle des feuilles du jour, hexadécimale.
  merkle_root       text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  -- Hash de l'ancre précédente du dossier ; NULL pour la première (GENESIS).
  prev_anchor_hash  text CHECK (prev_anchor_hash ~ '^[0-9a-f]{64}$'),
  -- sha256(prev|day|root|leaf_count) — cf. buildAnchor().
  anchor_hash       text NOT NULL CHECK (anchor_hash ~ '^[0-9a-f]{64}$'),
  leaf_count        integer NOT NULL CHECK (leaf_count > 0),
  entry_count       integer NOT NULL CHECK (entry_count >= 0),
  audit_count       integer NOT NULL CHECK (audit_count >= 0),
  built_at          timestamptz NOT NULL DEFAULT now(),
  built_by          uuid,

  -- --- Publication hors plateforme ---------------------------------------
  -- PENDING  : ancre calculée et conservée, pas encore sortie de la plateforme.
  --            Elle ne prouve encore rien à un tiers : c'est un état de panne
  --            ou d'attente, jamais un état normal durable.
  -- PUBLISHED: un tiers en détient une trace (jeton d'horodatage, accusé du
  --            point de dépôt). C'est seulement là que l'engagement est tenu.
  -- FAILED   : la dernière tentative de publication a échoué ; le motif est
  --            conservé, l'ancre reste republiable.
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  publisher         text,
  publication_ref   text,
  published_at      timestamptz,
  -- Preuve opposable telle que rendue par le tiers : jeton RFC 3161 (base64 du
  -- TimeStampResp) ou reçu signé. C'est ce champ qu'un auditeur ré-extrait.
  publication_proof text,
  publication_error text,

  UNIQUE (tenant_id, day),
  UNIQUE (tenant_id, anchor_hash),
  CHECK (leaf_count = entry_count + audit_count),
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
  CHECK (status <> 'PUBLISHED' OR (publisher IS NOT NULL AND publication_ref IS NOT NULL))
);

CREATE INDEX ledger_anchor_tenant_day_idx ON ledger_anchor (tenant_id, day DESC);
CREATE INDEX ledger_anchor_unpublished_idx ON ledger_anchor (tenant_id, day) WHERE status <> 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Immutabilité. Une ancre est une preuve : son contenu ne se réécrit pas et ne
-- se supprime pas. Seuls les champs de publication bougent, une seule fois,
-- tant que l'ancre n'est pas publiée. Comme pour le grand livre, c'est la base
-- qui refuse, pas l'application.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_anchor_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ARCOMPT: suppression interdite sur ledger_anchor (ancre du % — la chaîne d''ancres serait rompue)', OLD.day
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.day <> OLD.day
     OR NEW.merkle_root <> OLD.merkle_root
     OR NEW.anchor_hash <> OLD.anchor_hash
     OR NEW.prev_anchor_hash IS DISTINCT FROM OLD.prev_anchor_hash
     OR NEW.leaf_count <> OLD.leaf_count
     OR NEW.entry_count <> OLD.entry_count
     OR NEW.audit_count <> OLD.audit_count
     OR NEW.built_at <> OLD.built_at THEN
    RAISE EXCEPTION 'ARCOMPT: le contenu d''une ancre est immuable (ancre du %)', OLD.day USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'PUBLISHED'
     AND (NEW.status <> OLD.status
          OR NEW.publisher IS DISTINCT FROM OLD.publisher
          OR NEW.publication_ref IS DISTINCT FROM OLD.publication_ref
          OR NEW.published_at IS DISTINCT FROM OLD.published_at
          OR NEW.publication_proof IS DISTINCT FROM OLD.publication_proof) THEN
    RAISE EXCEPTION 'ARCOMPT: une ancre publiée ne se republie pas (ancre du %)', OLD.day USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER ledger_anchor_immutable_trg BEFORE UPDATE OR DELETE ON ledger_anchor
  FOR EACH ROW EXECUTE FUNCTION ledger_anchor_immutable();

-- ---------------------------------------------------------------------------
-- Isolation par dossier, comme toute table métier.
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_anchor
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Droits explicites : depuis 0010, aucune table nouvelle n'hérite plus de
-- privilèges par défaut. SELECT/INSERT pour produire et lire une ancre, UPDATE
-- pour porter le résultat de la publication ; jamais DELETE — une preuve ne
-- s'efface pas depuis l'application.
GRANT SELECT, INSERT, UPDATE ON ledger_anchor TO arcompt_app;
