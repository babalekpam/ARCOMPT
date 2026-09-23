-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- ARCOMPT — module trésorerie (0004)
-- Comptes de trésorerie (banque, caisse, mobile money), relevés importés,
-- lignes de relevé et leur rapprochement avec le grand livre, règles
-- d'imputation automatique, comptages de caisse.
--
-- Le grand livre reste la seule source de vérité : ce module ne touche jamais
-- journal_entry / journal_line en SQL, il ne fait que référencer journal_line
-- (matched_line_id) pour tracer le rapprochement.

-- ---------------------------------------------------------------------------
-- Comptes de trésorerie
-- ---------------------------------------------------------------------------
CREATE TABLE treasury_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('BANK', 'CASH', 'MOBILE_MONEY')),
  label           text NOT NULL,
  account_number  text NOT NULL CHECK (account_number ~ '^5[0-9]{1,12}$'), -- compte du plan : 521xx, 571, 5381…
  currency        char(3) NOT NULL,
  bank_name       text,
  iban            text,
  mm_operator     text,                           -- Orange Money, MTN MoMo, Wave, Moov…
  mm_phone        text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_number)
);
CREATE INDEX treasury_account_tenant_idx ON treasury_account(tenant_id, kind);

-- ---------------------------------------------------------------------------
-- Relevés importés (CSV, PDF lu par l'IA, SMS mobile money, API bancaire)
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statement (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  treasury_account_id  uuid NOT NULL REFERENCES treasury_account(id) ON DELETE CASCADE,
  period_from          date NOT NULL,
  period_to            date NOT NULL,
  opening_balance      numeric(20,4),
  closing_balance      numeric(20,4),
  source               text NOT NULL CHECK (source IN ('CSV', 'PDF', 'SMS', 'API')),
  document_id          uuid REFERENCES document(id),
  hash                 text NOT NULL,             -- empreinte du contenu : refuse un second import identique
  imported_by          uuid,
  imported_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, hash),
  CHECK (period_to >= period_from)
);
CREATE INDEX bank_statement_account_idx ON bank_statement(tenant_id, treasury_account_id, period_to DESC);

-- ---------------------------------------------------------------------------
-- Lignes de relevé. amount signé du point de vue de l'entreprise :
-- positif = encaissement, négatif = décaissement.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_transaction (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  statement_id         uuid NOT NULL REFERENCES bank_statement(id) ON DELETE CASCADE,
  treasury_account_id  uuid NOT NULL REFERENCES treasury_account(id) ON DELETE CASCADE,
  tx_date              date NOT NULL,
  value_date           date,
  label                text NOT NULL,
  amount               numeric(20,4) NOT NULL CHECK (amount <> 0),
  reference            text,
  external_id          text,                     -- identifiant côté banque / opérateur
  status               text NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN ('UNMATCHED', 'MATCHED', 'IGNORED')),
  matched_line_id      uuid REFERENCES journal_line(id),
  match_confidence     numeric(5,4) CHECK (match_confidence BETWEEN 0 AND 1),
  match_method         text CHECK (match_method IN ('RULE', 'AMOUNT_DATE', 'LLM', 'MANUAL')),
  matched_by           uuid,
  matched_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'MATCHED') = (matched_line_id IS NOT NULL)),
  CHECK (status <> 'MATCHED' OR match_method IS NOT NULL)
);
CREATE INDEX bank_transaction_statement_idx ON bank_transaction(tenant_id, statement_id);
CREATE INDEX bank_transaction_account_date_idx ON bank_transaction(tenant_id, treasury_account_id, tx_date, amount);
CREATE INDEX bank_transaction_status_idx ON bank_transaction(tenant_id, treasury_account_id, status);
-- Une ligne du grand livre ne se rapproche qu'avec une seule ligne de relevé.
CREATE UNIQUE INDEX bank_transaction_matched_line_uniq ON bank_transaction(tenant_id, matched_line_id) WHERE matched_line_id IS NOT NULL;
-- Un identifiant externe ne s'importe qu'une fois par compte.
CREATE UNIQUE INDEX bank_transaction_external_id_uniq ON bank_transaction(tenant_id, treasury_account_id, external_id) WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Règles d'imputation : motif sur le libellé → compte / tiers
-- ---------------------------------------------------------------------------
CREATE TABLE bank_rule (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  treasury_account_id  uuid REFERENCES treasury_account(id) ON DELETE CASCADE, -- NULL : tous les comptes
  pattern              text NOT NULL,             -- sous-chaîne (insensible à la casse et aux accents) ou regex
  is_regex             boolean NOT NULL DEFAULT false,
  account_number       text NOT NULL CHECK (account_number ~ '^[1-9][0-9]{0,12}$'),
  partner_id           uuid REFERENCES partner(id),
  label                text,
  priority             integer NOT NULL DEFAULT 100, -- plus petit = évalué en premier
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_rule_tenant_idx ON bank_rule(tenant_id, priority);

-- ---------------------------------------------------------------------------
-- Comptages de caisse
-- ---------------------------------------------------------------------------
CREATE TABLE cash_count (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  treasury_account_id  uuid NOT NULL REFERENCES treasury_account(id) ON DELETE CASCADE,
  counted_on           date NOT NULL,
  counted_amount       numeric(20,4) NOT NULL,
  book_amount          numeric(20,4) NOT NULL,
  difference           numeric(20,4) NOT NULL,     -- compté − comptable
  note                 text,
  entry_id             uuid REFERENCES journal_entry(id), -- écriture d'écart (658 / 758) si comptabilisée
  counted_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_count_account_idx ON cash_count(tenant_id, treasury_account_id, counted_on DESC);

-- ---------------------------------------------------------------------------
-- RLS et droits (cf. docs/MODULES.md)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treasury_account', 'bank_statement', 'bank_transaction', 'bank_rule', 'cash_count'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO arcompt_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
