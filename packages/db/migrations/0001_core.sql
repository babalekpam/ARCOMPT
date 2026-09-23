-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- ARCOMPT — schéma noyau (phase 0)
-- Toutes les tables métier portent tenant_id et sont protégées par Row-Level Security.
-- Les invariants comptables sont garantis ici, par la base, pas par l'application.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist; -- EXCLUDE (uuid =, daterange &&) sur period

-- Rôle applicatif : jamais superuser, jamais propriétaire des tables, soumis à la RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app') THEN
    CREATE ROLE arcompt_app NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Contexte tenant : lu depuis le jeton par l'API, jamais depuis le client.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_organization_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Organisation, utilisateurs, dossiers
-- ---------------------------------------------------------------------------
CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'COMPANY' CHECK (kind IN ('COMPANY', 'FIRM', 'GROUP')),
  plan        text NOT NULL DEFAULT 'TRIAL',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  keycloak_sub    text UNIQUE,
  email           text NOT NULL,
  display_name    text NOT NULL,
  locale          text NOT NULL DEFAULT 'fr',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- company = tenant. Un dossier référence un pack pays et sa version.
CREATE TABLE company (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  name               text NOT NULL,
  country_code       char(2) NOT NULL,
  currency           char(3) NOT NULL,
  accounting_system  text NOT NULL DEFAULT 'NORMAL' CHECK (accounting_system IN ('NORMAL', 'SMT')),
  tax_regime         text,
  pack_version       text NOT NULL,
  tax_ids            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_organization_idx ON company(organization_id);

CREATE TABLE company_member (
  company_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('OWNER', 'ACCOUNTANT', 'CASHIER', 'AUDITOR', 'REVIEWER')),
  PRIMARY KEY (company_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Exercices, périodes, plan de comptes, journaux, tiers
-- ---------------------------------------------------------------------------
CREATE TABLE fiscal_year (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code        text NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),
  UNIQUE (tenant_id, code),
  CHECK (end_date > start_date)
);

CREATE TABLE period (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fiscal_year_id  uuid NOT NULL REFERENCES fiscal_year(id) ON DELETE CASCADE,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),
  CHECK (end_date >= start_date),
  EXCLUDE USING gist (tenant_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
CREATE INDEX period_tenant_dates_idx ON period(tenant_id, start_date, end_date);

CREATE TABLE account (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  number      text NOT NULL CHECK (number ~ '^[1-9][0-9]{0,12}$'),
  label       text NOT NULL,
  class       smallint NOT NULL CHECK (class BETWEEN 1 AND 9),
  nature      text NOT NULL CHECK (nature IN ('ACTIF', 'PASSIF', 'CHARGE', 'PRODUIT', 'MIXTE', 'ENGAGEMENT')),
  lettrable   boolean NOT NULL DEFAULT false,
  postable    boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, number),
  CHECK (class = substr(number, 1, 1)::smallint)
);

CREATE TABLE journal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code        text NOT NULL,
  label       text NOT NULL,
  type        text NOT NULL CHECK (type IN ('ACHATS', 'VENTES', 'BANQUE', 'CAISSE', 'PAIE', 'OD', 'AN')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE partner (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'STATE', 'OTHER')),
  name                text NOT NULL,
  tax_id              text,
  collective_account  text NOT NULL, -- 401 / 411 / 421 / 44x
  contact             jsonb NOT NULL DEFAULT '{}'::jsonb,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_tenant_idx ON partner(tenant_id, type);

-- ---------------------------------------------------------------------------
-- Grand livre : journal_entry + journal_line
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entry (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  journal_id            uuid NOT NULL REFERENCES journal(id),
  fiscal_year_id        uuid NOT NULL REFERENCES fiscal_year(id),
  period_id             uuid NOT NULL REFERENCES period(id),
  number                integer,                       -- attribué à la validation, continu par journal
  entry_date            date NOT NULL,
  reference             text,
  label                 text NOT NULL,
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED')),
  source                text NOT NULL CHECK (source IN ('MANUAL', 'INVOICE', 'PURCHASE', 'BANK', 'PAYROLL', 'TAX', 'AI', 'IMPORT', 'REVERSAL', 'CLOSING')),
  reverses_entry_id     uuid REFERENCES journal_entry(id),
  reversed_by_entry_id  uuid REFERENCES journal_entry(id),
  prev_hash             text,
  hash                  text,
  client_id             uuid,                          -- idempotence hors ligne
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  validated_by          uuid,
  validated_at          timestamptz,
  UNIQUE (tenant_id, journal_id, number),
  UNIQUE (tenant_id, client_id),
  CHECK ((status = 'DRAFT') = (number IS NULL)),
  CHECK ((status = 'DRAFT') = (hash IS NULL))
);
CREATE INDEX journal_entry_tenant_date_idx ON journal_entry(tenant_id, entry_date);
CREATE INDEX journal_entry_period_idx ON journal_entry(tenant_id, period_id, status);

CREATE TABLE journal_line (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  entry_id       uuid NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  line_no        smallint NOT NULL,
  account_id     uuid NOT NULL REFERENCES account(id),
  partner_id     uuid REFERENCES partner(id),
  label          text NOT NULL DEFAULT '',
  debit          numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency       char(3) NOT NULL,
  rate           numeric(20,10),
  analytic_code  text,
  vat_code       text,
  UNIQUE (entry_id, line_no),
  CHECK (debit = 0 OR credit = 0),          -- débit ou crédit, jamais les deux
  CHECK (debit <> 0 OR credit <> 0)         -- jamais une ligne vide
);
CREATE INDEX journal_line_account_idx ON journal_line(tenant_id, account_id);
CREATE INDEX journal_line_partner_idx ON journal_line(tenant_id, partner_id) WHERE partner_id IS NOT NULL;

-- Soldes compte × période, tenus à la validation.
CREATE TABLE account_balance (
  tenant_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES account(id),
  period_id   uuid NOT NULL REFERENCES period(id),
  debit       numeric(20,4) NOT NULL DEFAULT 0,
  credit      numeric(20,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, account_id, period_id)
);

-- ---------------------------------------------------------------------------
-- Pièces, lettrage, immobilisations
-- ---------------------------------------------------------------------------
CREATE TABLE document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  entry_id     uuid REFERENCES journal_entry(id),
  storage_key  text NOT NULL,                 -- clé R2
  sha256       text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  extracted    jsonb,                          -- données lues par l'IA (proposition, jamais vérité)
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)                   -- détection de doublon par hash
);

CREATE TABLE reconciliation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('LETTRAGE', 'BANK')),
  code        text NOT NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_line (
  reconciliation_id  uuid NOT NULL REFERENCES reconciliation(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  line_id            uuid NOT NULL REFERENCES journal_line(id),
  PRIMARY KEY (reconciliation_id, line_id)
);

CREATE TABLE fixed_asset (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES account(id),  -- compte 2x
  label            text NOT NULL,
  acquired_on      date NOT NULL,
  cost             numeric(20,4) NOT NULL CHECK (cost >= 0),
  method           text NOT NULL DEFAULT 'LINEAR' CHECK (method IN ('LINEAR', 'DEGRESSIVE', 'NONE')),
  duration_months  integer CHECK (duration_months > 0),
  residual_value   numeric(20,4) NOT NULL DEFAULT 0,
  disposed_on      date,
  disposal_price   numeric(20,4)
);

-- ---------------------------------------------------------------------------
-- Piste d'audit : insertion seule, chaînée par hash
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  user_id    uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL DEFAULT now(),
  prev_hash  text,
  hash       text NOT NULL
);
CREATE INDEX audit_log_tenant_idx ON audit_log(tenant_id, id);

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
BEGIN
  SELECT hash INTO prev FROM audit_log WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := encode(digest(
    coalesce(prev, 'GENESIS') || '|' || NEW.tenant_id::text || '|' || coalesce(NEW.user_id::text, '') || '|' ||
    NEW.action || '|' || NEW.entity || '|' || NEW.entity_id || '|' ||
    coalesce(NEW.before::text, '') || '|' || coalesce(NEW.after::text, '') || '|' || NEW.at::text,
    'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ARCOMPT: % interdit sur %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Invariant 1 : équilibre. Trigger de contrainte différé : refuse toute
-- écriture dont débits ≠ crédits à la fin de la transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid := coalesce(NEW.entry_id, OLD.entry_id);
  v_debit numeric(20,4);
  v_credit numeric(20,4);
  v_count integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO v_debit, v_credit, v_count
    FROM journal_line WHERE entry_id = v_entry;
  IF v_count > 0 AND v_count < 2 THEN
    RAISE EXCEPTION 'ARCOMPT: écriture % avec moins de deux lignes', v_entry USING ERRCODE = 'P0002';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'ARCOMPT: écriture % déséquilibrée (débits % ≠ crédits %)', v_entry, v_debit, v_credit USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- ---------------------------------------------------------------------------
-- Invariant 2 : inaltérabilité. Une écriture validée ne change plus ; seul le
-- lien de contrepassation peut être renseigné, une seule fois.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION journal_entry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'VALIDATED' THEN
      RAISE EXCEPTION 'ARCOMPT: suppression interdite, écriture % validée ; contrepassez-la', OLD.id USING ERRCODE = 'P0003';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'VALIDATED' THEN
    IF NEW.status <> 'VALIDATED'
       OR NEW.tenant_id <> OLD.tenant_id OR NEW.journal_id <> OLD.journal_id
       OR NEW.period_id <> OLD.period_id OR NEW.fiscal_year_id <> OLD.fiscal_year_id
       OR NEW.number <> OLD.number OR NEW.entry_date <> OLD.entry_date
       OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.label <> OLD.label
       OR NEW.source <> OLD.source OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
       OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash OR NEW.hash <> OLD.hash
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.validated_by IS DISTINCT FROM OLD.validated_by OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
    THEN
      RAISE EXCEPTION 'ARCOMPT: modification interdite, écriture % validée ; contrepassez-la', OLD.id USING ERRCODE = 'P0003';
    END IF;
    IF OLD.reversed_by_entry_id IS NOT NULL AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id THEN
      RAISE EXCEPTION 'ARCOMPT: écriture % déjà contrepassée', OLD.id USING ERRCODE = 'P0003';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_immutable_trg BEFORE UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_immutable();

CREATE OR REPLACE FUNCTION journal_line_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_entry uuid := coalesce(NEW.entry_id, OLD.entry_id);
BEGIN
  SELECT status INTO v_status FROM journal_entry WHERE id = v_entry;
  IF v_status = 'VALIDATED' THEN
    RAISE EXCEPTION 'ARCOMPT: lignes de l''écriture % validée : % interdit', v_entry, TG_OP USING ERRCODE = 'P0003';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER journal_line_immutable_trg BEFORE INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_immutable();

-- ---------------------------------------------------------------------------
-- Invariant 3 : période verrouillée. Invariant 4 : chaînage et numérotation
-- continue par journal, vérifiés au passage DRAFT → VALIDATED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION journal_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_period record;
  v_last record;
BEGIN
  SELECT status, start_date, end_date, tenant_id INTO v_period FROM period WHERE id = NEW.period_id;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'ARCOMPT: période % introuvable', NEW.period_id USING ERRCODE = 'P0004';
  END IF;
  IF v_period.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'ARCOMPT: période d''un autre dossier' USING ERRCODE = 'P0004';
  END IF;
  IF NEW.entry_date < v_period.start_date OR NEW.entry_date > v_period.end_date THEN
    RAISE EXCEPTION 'ARCOMPT: date % hors de la période', NEW.entry_date USING ERRCODE = 'P0004';
  END IF;
  IF v_period.status <> 'OPEN' AND (TG_OP = 'INSERT' OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'ARCOMPT: période clôturée ou verrouillée (% → %)', v_period.start_date, v_period.end_date USING ERRCODE = 'P0004';
  END IF;

  IF NEW.status = 'VALIDATED' AND (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') THEN
    -- Sérialise les validations d'un même journal.
    PERFORM 1 FROM journal WHERE id = NEW.journal_id FOR UPDATE;
    SELECT number, hash INTO v_last
      FROM journal_entry
      WHERE tenant_id = NEW.tenant_id AND journal_id = NEW.journal_id AND status = 'VALIDATED' AND id <> NEW.id
      ORDER BY number DESC LIMIT 1;
    IF NEW.number IS DISTINCT FROM coalesce(v_last.number, 0) + 1 THEN
      RAISE EXCEPTION 'ARCOMPT: numérotation non continue (attendu %, reçu %)', coalesce(v_last.number, 0) + 1, NEW.number USING ERRCODE = 'P0005';
    END IF;
    IF NEW.prev_hash IS DISTINCT FROM v_last.hash THEN
      RAISE EXCEPTION 'ARCOMPT: chaîne de hash rompue sur le journal %', NEW.journal_id USING ERRCODE = 'P0005';
    END IF;
    IF NEW.hash IS NULL OR length(NEW.hash) <> 64 THEN
      RAISE EXCEPTION 'ARCOMPT: hash manquant' USING ERRCODE = 'P0005';
    END IF;
    IF NEW.validated_at IS NULL THEN NEW.validated_at := now(); END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_guard_trg BEFORE INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_guard();

-- Soldes : mis à jour à la validation (les brouillons ne comptent pas).
-- SECURITY DEFINER : seul ce trigger écrit dans account_balance ; le rôle
-- applicatif n'y a aucun droit d'écriture direct.
CREATE OR REPLACE FUNCTION journal_entry_update_balances() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'VALIDATED' AND (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') THEN
    INSERT INTO account_balance (tenant_id, account_id, period_id, debit, credit)
      SELECT NEW.tenant_id, l.account_id, NEW.period_id, sum(l.debit), sum(l.credit)
        FROM journal_line l WHERE l.entry_id = NEW.id
        GROUP BY l.account_id
    ON CONFLICT (tenant_id, account_id, period_id) DO UPDATE
      SET debit = account_balance.debit + EXCLUDED.debit,
          credit = account_balance.credit + EXCLUDED.credit;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER journal_entry_balances_trg AFTER INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_update_balances();

-- Lignes : compte et tiers du même dossier, compte imputable.
CREATE OR REPLACE FUNCTION journal_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_acc record;
  v_entry_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_entry_tenant FROM journal_entry WHERE id = NEW.entry_id;
  IF v_entry_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'ARCOMPT: ligne et écriture de dossiers différents' USING ERRCODE = 'P0006';
  END IF;
  SELECT tenant_id, postable, active, lettrable INTO v_acc FROM account WHERE id = NEW.account_id;
  IF v_acc.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'ARCOMPT: compte d''un autre dossier' USING ERRCODE = 'P0006';
  END IF;
  IF NOT v_acc.postable OR NOT v_acc.active THEN
    RAISE EXCEPTION 'ARCOMPT: compte non imputable ou désactivé' USING ERRCODE = 'P0006';
  END IF;
  IF v_acc.lettrable AND NEW.partner_id IS NULL THEN
    RAISE EXCEPTION 'ARCOMPT: tiers obligatoire sur un compte lettrable' USING ERRCODE = 'P0006';
  END IF;
  IF NEW.partner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partner WHERE id = NEW.partner_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'ARCOMPT: tiers d''un autre dossier' USING ERRCODE = 'P0006';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_line_guard_trg BEFORE INSERT OR UPDATE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_guard();

-- ---------------------------------------------------------------------------
-- Row-Level Security : le tenant vient du jeton (app.tenant_id), jamais du client.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fiscal_year', 'period', 'account', 'journal', 'partner', 'journal_entry', 'journal_line',
    'account_balance', 'document', 'reconciliation', 'reconciliation_line', 'fixed_asset', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
CREATE POLICY company_access ON company
  USING (id = app_tenant_id() OR organization_id = app_organization_id())
  WITH CHECK (organization_id = app_organization_id());

ALTER TABLE company_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_member FORCE ROW LEVEL SECURITY;
CREATE POLICY company_member_access ON company_member
  USING (company_id = app_tenant_id() OR EXISTS (SELECT 1 FROM company c WHERE c.id = company_member.company_id AND c.organization_id = app_organization_id()));

ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_access ON organization USING (id = app_organization_id());

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
CREATE POLICY app_user_access ON app_user USING (organization_id = app_organization_id() OR id = app_user_id());

GRANT USAGE ON SCHEMA public TO arcompt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
REVOKE UPDATE, DELETE ON audit_log FROM arcompt_app;
REVOKE INSERT, UPDATE, DELETE ON account_balance FROM arcompt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO arcompt_app;
