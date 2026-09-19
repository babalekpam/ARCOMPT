-- ARCOMPT — facturation, achats, règlements, relances (module invoicing)
-- Toute table porte tenant_id, RLS forcée, politique tenant_isolation, droits au rôle arcompt_app.
-- Le grand livre n'est jamais écrit ici : entry_id référence l'écriture posée par Ledger.post().

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE product (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code                    text NOT NULL,
  label                   text NOT NULL,
  description             text,
  default_account_number  text NOT NULL CHECK (default_account_number ~ '^[1-9][0-9]{0,12}$'), -- 701 / 706…
  vat_code                text,                                                                -- code du pack (TVA18, EXO) ; NULL = hors champ
  unit_price              numeric(20,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit                    text NOT NULL DEFAULT 'u',
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX product_tenant_idx ON product(tenant_id, active);

-- ---------------------------------------------------------------------------
-- Numérotation légale : continue, sans trou, par dossier / type / année.
-- Le numéro n'est attribué qu'à la sortie du brouillon et n'est jamais réutilisé.
-- ---------------------------------------------------------------------------
CREATE TABLE document_sequence (
  tenant_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind         text NOT NULL,      -- QUOTE, INVOICE, CREDIT_NOTE, SUPPLIER_INVOICE, SUPPLIER_CREDIT_NOTE, EXPENSE_CLAIM, PAYMENT
  year         integer NOT NULL,
  prefix       text NOT NULL,      -- DEV, FAC, AV, FF, AF, NDF, REG
  next_number  integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (tenant_id, kind, year)
);

-- ---------------------------------------------------------------------------
-- Paramètres du module par dossier (seuil de double validation des règlements)
-- ---------------------------------------------------------------------------
CREATE TABLE invoicing_settings (
  tenant_id                   uuid PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  -- Au-delà (≥) de ce montant, un règlement doit être approuvé par un utilisateur différent
  -- de celui qui l'a saisi (séparation des tâches, docs/SECURITY.md §4).
  payment_approval_threshold  numeric(20,4) NOT NULL DEFAULT 1000000 CHECK (payment_approval_threshold >= 0),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ventes : devis, factures, avoirs
-- ---------------------------------------------------------------------------
CREATE TABLE sales_document (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('QUOTE', 'INVOICE', 'CREDIT_NOTE')),
  number              text,                                   -- numéro légal, NULL tant que brouillon
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'ACCEPTED', 'REFUSED')),
  partner_id          uuid NOT NULL REFERENCES partner(id),
  issue_date          date NOT NULL,
  due_date            date,
  currency            char(3) NOT NULL,
  total_net           numeric(20,4) NOT NULL DEFAULT 0,
  total_vat           numeric(20,4) NOT NULL DEFAULT 0,
  total_gross         numeric(20,4) NOT NULL DEFAULT 0,
  paid_amount         numeric(20,4) NOT NULL DEFAULT 0,       -- règlements alloués (factures)
  credited_amount     numeric(20,4) NOT NULL DEFAULT 0,       -- avoirs émis sur cette facture
  notes               text,
  entry_id            uuid REFERENCES journal_entry(id),      -- écriture posée à l'émission
  certification       jsonb,                                  -- { reference, qrCode, certifiedAt, system } (FNE, MECeF…)
  source_document_id  uuid REFERENCES sales_document(id),     -- devis d'origine, ou facture corrigée par l'avoir
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('DRAFT', 'CANCELLED')) = (number IS NULL)), -- le numéro n'existe qu'une fois émis
  CHECK (status <> 'CANCELLED' OR number IS NULL)             -- seul un brouillon s'annule
);
CREATE UNIQUE INDEX sales_document_number_idx ON sales_document(tenant_id, kind, number) WHERE number IS NOT NULL;
CREATE INDEX sales_document_tenant_idx ON sales_document(tenant_id, kind, status, issue_date);
CREATE INDEX sales_document_partner_idx ON sales_document(tenant_id, partner_id);

CREATE TABLE sales_document_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES sales_document(id) ON DELETE CASCADE,
  line_no         smallint NOT NULL,
  product_id      uuid REFERENCES product(id),
  label           text NOT NULL,
  quantity        numeric(20,4) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit_price      numeric(20,4) NOT NULL DEFAULT 0,
  account_number  text NOT NULL CHECK (account_number ~ '^[1-9][0-9]{0,12}$'),
  vat_code        text,
  vat_rate        numeric(20,10) NOT NULL DEFAULT 0,
  net             numeric(20,4) NOT NULL DEFAULT 0,
  vat             numeric(20,4) NOT NULL DEFAULT 0,
  gross           numeric(20,4) NOT NULL DEFAULT 0,
  UNIQUE (document_id, line_no)
);
CREATE INDEX sales_document_line_doc_idx ON sales_document_line(tenant_id, document_id);

-- ---------------------------------------------------------------------------
-- Achats : factures fournisseurs, avoirs fournisseurs, notes de frais
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_document (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('SUPPLIER_INVOICE', 'SUPPLIER_CREDIT_NOTE', 'EXPENSE_CLAIM')),
  number              text,                                   -- numéro interne, NULL tant que brouillon
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED')),
  partner_id          uuid NOT NULL REFERENCES partner(id),   -- fournisseur (401) ou salarié (421)
  reference           text,                                   -- numéro de la facture du fournisseur
  issue_date          date NOT NULL,
  due_date            date,
  currency            char(3) NOT NULL,
  total_net           numeric(20,4) NOT NULL DEFAULT 0,
  total_vat           numeric(20,4) NOT NULL DEFAULT 0,
  total_gross         numeric(20,4) NOT NULL DEFAULT 0,
  paid_amount         numeric(20,4) NOT NULL DEFAULT 0,
  credited_amount     numeric(20,4) NOT NULL DEFAULT 0,
  notes               text,
  entry_id            uuid REFERENCES journal_entry(id),
  document_id         uuid REFERENCES document(id),           -- pièce justificative (photo, PDF)
  source_document_id  uuid REFERENCES purchase_document(id),  -- facture corrigée par l'avoir
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('DRAFT', 'CANCELLED')) = (number IS NULL)),
  CHECK (status <> 'CANCELLED' OR number IS NULL)
);
CREATE UNIQUE INDEX purchase_document_number_idx ON purchase_document(tenant_id, kind, number) WHERE number IS NOT NULL;
CREATE INDEX purchase_document_tenant_idx ON purchase_document(tenant_id, kind, status, issue_date);
CREATE INDEX purchase_document_partner_idx ON purchase_document(tenant_id, partner_id);

CREATE TABLE purchase_document_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES purchase_document(id) ON DELETE CASCADE,
  line_no         smallint NOT NULL,
  account_number  text NOT NULL CHECK (account_number ~ '^[1-9][0-9]{0,12}$'), -- 60x–63x
  label           text NOT NULL,
  net             numeric(20,4) NOT NULL DEFAULT 0,
  vat_code        text,
  vat_rate        numeric(20,10) NOT NULL DEFAULT 0,
  vat             numeric(20,4) NOT NULL DEFAULT 0,
  gross           numeric(20,4) NOT NULL DEFAULT 0,
  UNIQUE (document_id, line_no)
);
CREATE INDEX purchase_document_line_doc_idx ON purchase_document_line(tenant_id, document_id);

-- ---------------------------------------------------------------------------
-- Règlements et affectations
-- ---------------------------------------------------------------------------
CREATE TABLE payment (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind                     text NOT NULL CHECK (kind IN ('RECEIPT', 'DISBURSEMENT')),
  method                   text NOT NULL CHECK (method IN ('BANK', 'CASH', 'MOBILE_MONEY', 'CHEQUE')),
  number                   text NOT NULL,
  treasury_account_number  text NOT NULL CHECK (treasury_account_number ~ '^5[0-9]{1,12}$'), -- 521 / 571 / 5381
  partner_id               uuid NOT NULL REFERENCES partner(id),
  amount                   numeric(20,4) NOT NULL CHECK (amount > 0),
  currency                 char(3) NOT NULL,
  payment_date             date NOT NULL,
  reference                text,                                  -- numéro de chèque, libellé de virement
  entry_id                 uuid REFERENCES journal_entry(id),
  provider                 text,                                  -- opérateur mobile money (wave, orange-money, mock…)
  provider_tx_id           text,                                  -- identifiant de transaction chez l'opérateur
  provider_event_id        text,                                  -- identifiant de l'événement webhook (idempotence stricte)
  -- RECORDED : écriture posée ; PENDING_APPROVAL : attend un second utilisateur (seuil) ;
  -- REVIEW : écart montant attendu / reçu, revue humaine ; REJECTED : refusé, jamais comptabilisé.
  status                   text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'PENDING_APPROVAL', 'REVIEW', 'REJECTED')),
  review_reason            text,
  approved_by              uuid,
  approved_at              timestamptz,
  created_by               uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (status <> 'RECORDED' OR entry_id IS NOT NULL),          -- un règlement comptabilisé a toujours son écriture
  CHECK (approved_by IS NULL OR approved_by <> created_by)       -- séparation des tâches, imposée par la base
);
CREATE UNIQUE INDEX payment_provider_tx_idx ON payment(tenant_id, provider, provider_tx_id) WHERE provider_tx_id IS NOT NULL;
CREATE UNIQUE INDEX payment_provider_event_idx ON payment(tenant_id, provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX payment_tenant_idx ON payment(tenant_id, kind, payment_date);
CREATE INDEX payment_partner_idx ON payment(tenant_id, partner_id);

CREATE TABLE payment_allocation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  payment_id            uuid NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  sales_document_id     uuid REFERENCES sales_document(id),
  purchase_document_id  uuid REFERENCES purchase_document(id),
  amount                numeric(20,4) NOT NULL CHECK (amount > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((sales_document_id IS NULL) <> (purchase_document_id IS NULL))  -- exactement un document
);
CREATE INDEX payment_allocation_payment_idx ON payment_allocation(tenant_id, payment_id);
CREATE INDEX payment_allocation_sales_idx ON payment_allocation(tenant_id, sales_document_id) WHERE sales_document_id IS NOT NULL;
CREATE INDEX payment_allocation_purchase_idx ON payment_allocation(tenant_id, purchase_document_id) WHERE purchase_document_id IS NOT NULL;

-- Liens de paiement mobile money émis pour une facture.
CREATE TABLE payment_link (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  sales_document_id  uuid NOT NULL REFERENCES sales_document(id),
  provider           text NOT NULL,
  provider_ref       text NOT NULL,                              -- référence du lien chez l'opérateur
  url                text NOT NULL,
  amount             numeric(20,4) NOT NULL CHECK (amount > 0),
  currency           char(3) NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  payment_id         uuid REFERENCES payment(id),
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_ref)
);
CREATE INDEX payment_link_document_idx ON payment_link(tenant_id, sales_document_id);

-- Journal des webhooks reçus : idempotence par identifiant d'événement et
-- protection contre le rejeu par nonce (docs/SECURITY.md §7 et §9).
CREATE TABLE webhook_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  nonce        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('PROCESSED', 'REVIEW', 'IGNORED', 'FAILED')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_id   uuid REFERENCES payment(id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, event_id),
  UNIQUE (tenant_id, provider, nonce)
);
CREATE INDEX webhook_event_tenant_idx ON webhook_event(tenant_id, provider, received_at DESC);

-- Résolution d'un lien de paiement vers son dossier, sans contexte tenant (webhook
-- entrant). SECURITY DEFINER limité : ne renvoie que l'identifiant du dossier.
CREATE OR REPLACE FUNCTION payment_link_resolve(p_provider text, p_provider_ref text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.tenant_id FROM payment_link l WHERE l.provider = p_provider AND l.provider_ref = p_provider_ref LIMIT 1
$$;
REVOKE ALL ON FUNCTION payment_link_resolve(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_link_resolve(text, text) TO arcompt_app;

-- ---------------------------------------------------------------------------
-- Relances
-- ---------------------------------------------------------------------------
CREATE TABLE dunning (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  sales_document_id  uuid NOT NULL REFERENCES sales_document(id),
  level              smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  channel            text NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP', 'SMS')),
  sent_at            timestamptz NOT NULL DEFAULT now(),
  message            text,
  sent_by            uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dunning_document_idx ON dunning(tenant_id, sales_document_id, level);

-- ---------------------------------------------------------------------------
-- updated_at automatique
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER sales_document_touch BEFORE UPDATE ON sales_document FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER purchase_document_touch BEFORE UPDATE ON purchase_document FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security et droits
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'product', 'document_sequence', 'invoicing_settings', 'sales_document', 'sales_document_line', 'purchase_document', 'purchase_document_line',
    'payment', 'payment_allocation', 'payment_link', 'webhook_event', 'dunning'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO arcompt_app', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
