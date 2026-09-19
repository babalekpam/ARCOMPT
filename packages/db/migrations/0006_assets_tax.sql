-- ARCOMPT — immobilisations et fiscalité (modules assets et tax)
-- La table fixed_asset existe depuis 0001_core.sql : on la complète.

-- ---------------------------------------------------------------------------
-- Immobilisations : fiche enrichie
-- ---------------------------------------------------------------------------
ALTER TABLE fixed_asset
  ADD COLUMN category                    text NOT NULL DEFAULT 'CORPORELLE' CHECK (category IN ('INCORPORELLE', 'CORPORELLE', 'FINANCIERE')),
  ADD COLUMN reference                   text,
  ADD COLUMN account_number              text,                                 -- compte 2xx (copie du numéro, lecture rapide)
  ADD COLUMN depreciation_account_number text,                                 -- compte 28xx crédité par la dotation
  ADD COLUMN expense_account_number      text NOT NULL DEFAULT '681',          -- compte 68x débité par la dotation
  ADD COLUMN in_service_on               date,                                 -- date de mise en service (début d'amortissement) ; défaut = acquisition
  ADD COLUMN prorata                     text NOT NULL DEFAULT 'DAYS' CHECK (prorata IN ('DAYS', 'MONTHS')),
  ADD COLUMN degressive_coefficient      numeric(6,4),                         -- coefficient dégressif ; NULL = déduit de la durée
  ADD COLUMN prior_depreciation          numeric(20,4) NOT NULL DEFAULT 0 CHECK (prior_depreciation >= 0), -- amortissements antérieurs (reprise de balance)
  ADD COLUMN acquisition_entry_id        uuid REFERENCES journal_entry(id),
  ADD COLUMN disposal_entry_id           uuid REFERENCES journal_entry(id),    -- sortie (81x / 28xx / 2xx)
  ADD COLUMN disposal_proceeds_entry_id  uuid REFERENCES journal_entry(id),    -- produit de cession (5xx ou 485 / 82x)
  ADD COLUMN created_by                  uuid,
  ADD COLUMN created_at                  timestamptz NOT NULL DEFAULT now();
CREATE INDEX fixed_asset_tenant_idx ON fixed_asset(tenant_id, acquired_on);

-- Dotations enregistrées : une ligne par immobilisation et par date d'arrêté.
CREATE TABLE asset_depreciation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL REFERENCES fixed_asset(id) ON DELETE CASCADE,
  fiscal_year_id   uuid NOT NULL REFERENCES fiscal_year(id),
  period_end       date NOT NULL,                       -- date d'arrêté de la dotation (fin de mois, d'exercice ou de cession)
  dotation         numeric(20,4) NOT NULL CHECK (dotation >= 0),
  cumulative       numeric(20,4) NOT NULL CHECK (cumulative >= 0),  -- amortissements cumulés après cette dotation
  net_book_value   numeric(20,4) NOT NULL CHECK (net_book_value >= 0),
  entry_id         uuid REFERENCES journal_entry(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period_end)
);
CREATE INDEX asset_depreciation_tenant_idx ON asset_depreciation(tenant_id, fiscal_year_id, period_end);

-- ---------------------------------------------------------------------------
-- Fiscalité : déclarations (TVA, acomptes IS, retenues, DSF)
-- ---------------------------------------------------------------------------
CREATE TABLE tax_return (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('VAT', 'IS_INSTALMENT', 'WITHHOLDING', 'DSF')),
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COMPUTED', 'VALIDATED', 'FILED')),
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,     -- détail du calcul (montants en chaînes, jamais en flottants)
  amount_due        numeric(20,4) NOT NULL DEFAULT 0,
  entry_id          uuid REFERENCES journal_entry(id),      -- écriture de liquidation
  payment_entry_id  uuid REFERENCES journal_entry(id),      -- écriture de règlement
  filing_reference  text,
  filed_at          timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE INDEX tax_return_tenant_idx ON tax_return(tenant_id, kind, period_from, period_to);

-- ---------------------------------------------------------------------------
-- RLS et droits
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_depreciation', 'tax_return'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON fixed_asset, asset_depreciation, tax_return TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
