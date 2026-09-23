-- ARCOMPT — multidevise (phase 0012)
--
-- Trois choses, dans cet ordre :
--   1. une table des taux de change (source, validité, paire, taux, provenance) ;
--   2. sur chaque ligne d'écriture, le montant converti à côté du montant
--      d'origine — l'auditeur doit voir les deux ;
--   3. l'équilibre et les soldes recalculés sur le montant converti, parce
--      qu'additionner un euro et un franc ne veut rien dire.
--
-- Reprise des données : toute ligne existante est monodevise, donc converti =
-- origine. Aucun solde ne bouge.

-- ---------------------------------------------------------------------------
-- 1. Taux de change
-- ---------------------------------------------------------------------------
-- Convention unique dans tout le produit :
--     montant en from_currency × rate = montant en to_currency
-- Le taux stocké sur une ligne d'écriture va donc toujours de la devise de la
-- ligne vers la devise du dossier.
CREATE TABLE exchange_rate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- tenant_id NULL = parité fixe du système (zone franc), lisible par tous les
  -- dossiers et écrite par les seules migrations : personne ne ressaisit la
  -- parité XOF/EUR chaque matin. Toute autre ligne porte son dossier et suit
  -- l'isolation habituelle du schéma.
  tenant_id      uuid REFERENCES company(id) ON DELETE CASCADE,
  from_currency  char(3) NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency    char(3) NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
  rate           numeric(20,10) NOT NULL CHECK (rate > 0),
  -- Validité. Un cours du jour : valid_from = valid_until = ce jour. Une parité
  -- fixe : valid_until NULL, elle vaut jusqu'à décision contraire.
  valid_from     date NOT NULL,
  valid_until    date,
  source         text NOT NULL CHECK (source IN ('FIXED', 'BCEAO', 'BEAC', 'CENTRAL_BANK', 'MANUAL', 'IMPORT', 'API')),
  -- D'où vient ce taux : bulletin, URL, nom du fichier importé, opérateur.
  -- Un taux sans provenance n'est pas auditable.
  source_ref     text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX exchange_rate_tenant_pair_idx
  ON exchange_rate (tenant_id, from_currency, to_currency, valid_from, source)
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX exchange_rate_system_pair_idx
  ON exchange_rate (from_currency, to_currency, valid_from, source)
  WHERE tenant_id IS NULL;
CREATE INDEX exchange_rate_lookup_idx ON exchange_rate (from_currency, to_currency, valid_from DESC);

-- Parités fixes de la zone franc. Le XOF et le XAF sont arrimés à l'euro à
-- 1 EUR = 655,957 depuis le 1er janvier 1999 ; le KMF à 1 EUR = 491,96775.
-- Les taux inverses sont stockés explicitement : une division arrondie à la
-- volée donnerait deux résultats selon le sens de la conversion.
-- (Inséré avant l'activation de la RLS : ces lignes n'appartiennent à personne.)
INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate, valid_from, source, source_ref) VALUES
  (NULL, 'EUR', 'XOF', 655.9570000000,   DATE '1999-01-01', 'FIXED', 'Parité fixe UEMOA — 1 EUR = 655,957 XOF'),
  (NULL, 'XOF', 'EUR',   0.0015244902,   DATE '1999-01-01', 'FIXED', 'Parité fixe UEMOA — inverse de 655,957'),
  (NULL, 'EUR', 'XAF', 655.9570000000,   DATE '1999-01-01', 'FIXED', 'Parité fixe CEMAC — 1 EUR = 655,957 XAF'),
  (NULL, 'XAF', 'EUR',   0.0015244902,   DATE '1999-01-01', 'FIXED', 'Parité fixe CEMAC — inverse de 655,957'),
  (NULL, 'EUR', 'KMF', 491.9677500000,   DATE '1999-01-01', 'FIXED', 'Parité fixe comorienne — 1 EUR = 491,96775 KMF'),
  (NULL, 'KMF', 'EUR',   0.0020326536,   DATE '1999-01-01', 'FIXED', 'Parité fixe comorienne — inverse de 491,96775'),
  -- XOF et XAF partagent la même parité à l'euro : ils s'échangent à l'unité.
  (NULL, 'XOF', 'XAF',   1.0000000000,   DATE '1999-01-01', 'FIXED', 'Même parité à l''euro que le XAF'),
  (NULL, 'XAF', 'XOF',   1.0000000000,   DATE '1999-01-01', 'FIXED', 'Même parité à l''euro que le XOF');

ALTER TABLE exchange_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate FORCE ROW LEVEL SECURITY;
-- Lecture : ses propres taux, plus les parités fixes du système.
CREATE POLICY exchange_rate_read ON exchange_rate FOR SELECT
  USING (tenant_id = app_tenant_id() OR tenant_id IS NULL);
-- Écriture : ses propres taux, uniquement. Une parité fixe ne se modifie ni ne
-- se supprime depuis l'application (DELETE ne consulte que le USING de cette
-- politique-ci, la politique de lecture ne portant que sur SELECT).
CREATE POLICY exchange_rate_write ON exchange_rate FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON exchange_rate TO arcompt_app;

-- ---------------------------------------------------------------------------
-- 2. Montant converti sur la ligne d'écriture
-- ---------------------------------------------------------------------------
ALTER TABLE journal_line
  ADD COLUMN debit_base  numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit_base >= 0),
  ADD COLUMN credit_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit_base >= 0),
  -- Provenance du taux appliqué ('FIXED', 'BCEAO', 'MANUAL'…) : recopiée depuis
  -- exchange_rate, ou 'MANUAL' quand le taux est saisi sur la pièce.
  ADD COLUMN rate_source text;

ALTER TABLE journal_line
  ADD CONSTRAINT journal_line_base_one_side CHECK (debit_base = 0 OR credit_base = 0);

-- Reprise. La RLS est levée le temps de la reprise : la migration tourne sans
-- contexte tenant, sans quoi elle ne verrait aucune ligne. Les triggers
-- d'immutabilité et d'équilibre sont neutralisés : ils refuseraient de toucher
-- des écritures validées, alors qu'aucun montant ne change ici.
ALTER TABLE journal_line NO FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_line DISABLE TRIGGER journal_line_immutable_trg;
ALTER TABLE journal_line DISABLE TRIGGER journal_line_guard_trg;
ALTER TABLE journal_line DISABLE TRIGGER journal_line_balanced;

UPDATE journal_line SET debit_base = debit, credit_base = credit;

ALTER TABLE journal_line ENABLE TRIGGER journal_line_balanced;
ALTER TABLE journal_line ENABLE TRIGGER journal_line_guard_trg;
ALTER TABLE journal_line ENABLE TRIGGER journal_line_immutable_trg;
ALTER TABLE journal_line FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Invariant : la conversion est calculée par la base, pas seulement par
--    l'application. Une ligne dans une devise autre que celle du dossier exige
--    un taux ; le montant converti en découle et ne se saisit pas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION journal_line_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_base char(3);
BEGIN
  SELECT currency INTO v_base FROM company WHERE id = NEW.tenant_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'ARCOMPT: devise du dossier % introuvable', NEW.tenant_id USING ERRCODE = 'P0007';
  END IF;

  IF NEW.currency = v_base THEN
    IF NEW.rate IS NOT NULL AND NEW.rate <> 1 THEN
      RAISE EXCEPTION 'ARCOMPT: taux % interdit sur une ligne déjà dans la devise du dossier (%)', NEW.rate, v_base USING ERRCODE = 'P0007';
    END IF;
    NEW.debit_base := NEW.debit;
    NEW.credit_base := NEW.credit;
  ELSE
    IF NEW.rate IS NULL THEN
      RAISE EXCEPTION 'ARCOMPT: ligne en % sans taux de conversion vers % ; une devise étrangère exige un taux', NEW.currency, v_base USING ERRCODE = 'P0007';
    END IF;
    IF NEW.rate <= 0 THEN
      RAISE EXCEPTION 'ARCOMPT: taux de conversion % invalide', NEW.rate USING ERRCODE = 'P0007';
    END IF;
    -- Arrondi au plus proche à 4 décimales, demi vers l'infini : exactement ce
    -- que fait Money.mulRate côté applicatif. Les deux ne peuvent pas diverger.
    NEW.debit_base := round(NEW.debit * NEW.rate, 4);
    NEW.credit_base := round(NEW.credit * NEW.rate, 4);
    IF (NEW.debit <> 0 AND NEW.debit_base = 0) OR (NEW.credit <> 0 AND NEW.credit_base = 0) THEN
      RAISE EXCEPTION 'ARCOMPT: le taux % ramène le montant à zéro en % ; montant ou taux à revoir', NEW.rate, v_base USING ERRCODE = 'P0007';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_line_currency_trg BEFORE INSERT OR UPDATE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_currency_guard();

-- ---------------------------------------------------------------------------
-- 4. Équilibre et soldes sur le montant converti
-- ---------------------------------------------------------------------------
-- Remplace la version de 0001_core.sql, qui sommait débits et crédits sans
-- dimension devise : une écriture mêlant euro et franc y paraissait équilibrée.
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid := coalesce(NEW.entry_id, OLD.entry_id);
  v_debit numeric(20,4);
  v_credit numeric(20,4);
  v_count integer;
BEGIN
  SELECT coalesce(sum(debit_base), 0), coalesce(sum(credit_base), 0), count(*)
    INTO v_debit, v_credit, v_count
    FROM journal_line WHERE entry_id = v_entry;
  IF v_count > 0 AND v_count < 2 THEN
    RAISE EXCEPTION 'ARCOMPT: écriture % avec moins de deux lignes', v_entry USING ERRCODE = 'P0002';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'ARCOMPT: écriture % déséquilibrée (débits % ≠ crédits %, montants convertis)', v_entry, v_debit, v_credit USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END $$;

-- Idem pour les soldes : account_balance est tenu dans la devise du dossier.
CREATE OR REPLACE FUNCTION journal_entry_update_balances() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'VALIDATED' AND (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') THEN
    INSERT INTO account_balance (tenant_id, account_id, period_id, debit, credit)
      SELECT NEW.tenant_id, l.account_id, NEW.period_id, sum(l.debit_base), sum(l.credit_base)
        FROM journal_line l WHERE l.entry_id = NEW.id
        GROUP BY l.account_id
    ON CONFLICT (tenant_id, account_id, period_id) DO UPDATE
      SET debit = account_balance.debit + EXCLUDED.debit,
          credit = account_balance.credit + EXCLUDED.credit;
  END IF;
  RETURN NULL;
END $$;

-- Lecture des positions en devise : une ligne par compte × devise, montant
-- d'origine et montant converti. Sert à la retranslation de fin de période.
CREATE INDEX journal_line_currency_idx ON journal_line (tenant_id, currency) WHERE rate IS NOT NULL;
