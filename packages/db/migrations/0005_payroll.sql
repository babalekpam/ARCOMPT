-- ARCOMPT — module paie (0005)
-- Salariés, bulletins, cycles de paie et déclarations sociales / fiscales.
--
-- Les champs sensibles (salaire de base, coordonnées bancaires, numéro de
-- sécurité sociale) ne sont jamais stockés en clair : colonnes `*_enc`
-- chiffrées au niveau applicatif (AES-256-GCM, packages/payroll/src/crypto.ts).
-- Les montants calculés d'un bulletin (brut, net, cotisations) restent en clair
-- en numeric(20,4) : ils alimentent le grand livre, le livre de paie et les
-- déclarations, et sont protégés par la RLS comme le reste du dossier.

-- ---------------------------------------------------------------------------
-- Salariés
-- ---------------------------------------------------------------------------
CREATE TABLE employee (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  partner_id              uuid NOT NULL REFERENCES partner(id),      -- tiers de type EMPLOYEE (compte 422)
  matricule               text NOT NULL,
  first_name              text NOT NULL,
  last_name               text NOT NULL,
  hire_date               date NOT NULL,
  leave_date              date,
  contract_type           text NOT NULL DEFAULT 'CDI' CHECK (contract_type IN ('CDI', 'CDD', 'STAGE', 'JOURNALIER', 'AUTRE')),
  category                text,                                       -- catégorie professionnelle (convention collective)
  base_salary_enc         text NOT NULL,                              -- salaire de base mensuel, chiffré
  allowances              jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{ code, label, amount, taxable }]
  bank_details_enc        text,                                       -- { bank, iban, rib… }, chiffré
  social_security_number_enc text,                                    -- numéro CNPS / IPRES…, chiffré
  tax_id                  text,
  dependants              smallint NOT NULL DEFAULT 0 CHECK (dependants >= 0),
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, matricule),
  UNIQUE (tenant_id, partner_id),
  CHECK (leave_date IS NULL OR leave_date >= hire_date)
);
CREATE INDEX employee_tenant_idx ON employee(tenant_id, active, last_name);

-- ---------------------------------------------------------------------------
-- Cycle de paie mensuel
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  year                  smallint NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month                 smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COMPUTED', 'VALIDATED', 'PAID')),
  pack_version          text NOT NULL,                                -- ex. "ci@2025.1" : pack ayant servi au calcul
  employee_count        integer NOT NULL DEFAULT 0,
  total_gross           numeric(20,4) NOT NULL DEFAULT 0,
  total_employee_contributions numeric(20,4) NOT NULL DEFAULT 0,
  total_employer_contributions numeric(20,4) NOT NULL DEFAULT 0,
  total_income_tax      numeric(20,4) NOT NULL DEFAULT 0,
  total_net             numeric(20,4) NOT NULL DEFAULT 0,
  total_employer_cost   numeric(20,4) NOT NULL DEFAULT 0,
  entry_id              uuid REFERENCES journal_entry(id),           -- écriture de paie (661/664 à 422/431/447)
  payment_entry_id      uuid REFERENCES journal_entry(id),           -- écriture de règlement (422 à 521/571)
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  computed_at           timestamptz,
  validated_by          uuid,
  validated_at          timestamptz,
  paid_at               timestamptz,
  UNIQUE (tenant_id, year, month),
  CHECK ((status IN ('VALIDATED', 'PAID')) = (entry_id IS NOT NULL)),
  CHECK ((status = 'PAID') = (payment_entry_id IS NOT NULL))
);
CREATE INDEX payroll_run_tenant_idx ON payroll_run(tenant_id, year, month);

-- ---------------------------------------------------------------------------
-- Bulletins
-- ---------------------------------------------------------------------------
CREATE TABLE payslip (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  run_id                  uuid NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
  employee_id             uuid NOT NULL REFERENCES employee(id),
  currency                char(3) NOT NULL,
  gross                   numeric(20,4) NOT NULL CHECK (gross >= 0),
  taxable_base            numeric(20,4) NOT NULL,
  employee_contributions  numeric(20,4) NOT NULL DEFAULT 0,
  employer_contributions  numeric(20,4) NOT NULL DEFAULT 0,
  income_tax              numeric(20,4) NOT NULL DEFAULT 0,
  net                     numeric(20,4) NOT NULL,                    -- net après retenues, avant acomptes
  advance                 numeric(20,4) NOT NULL DEFAULT 0,          -- acomptes déjà versés (421)
  net_to_pay              numeric(20,4) NOT NULL,                    -- montant crédité au 422
  employer_cost           numeric(20,4) NOT NULL,
  -- [{ id, kind, label, base, rate, employee_amount, employer_amount, account }]
  lines                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  inputs                  jsonb NOT NULL DEFAULT '{}'::jsonb,        -- variables du mois (heures sup., primes, absences, acompte)
  pdf_document_id         uuid REFERENCES document(id),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id)
);
CREATE INDEX payslip_tenant_run_idx ON payslip(tenant_id, run_id);
CREATE INDEX payslip_tenant_employee_idx ON payslip(tenant_id, employee_id);

-- ---------------------------------------------------------------------------
-- Déclarations sociales et fiscales de la période
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_declaration (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind              text NOT NULL,                                   -- CNPS, IPRES, ITS… (identifiant de cotisation du pack, en majuscules)
  label             text NOT NULL,
  year              smallint NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month             smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  base              numeric(20,4) NOT NULL DEFAULT 0,
  employee_amount   numeric(20,4) NOT NULL DEFAULT 0,
  employer_amount   numeric(20,4) NOT NULL DEFAULT 0,
  amount            numeric(20,4) NOT NULL DEFAULT 0,                -- total à reverser
  account           text NOT NULL,                                   -- compte de tiers crédité (431, 447…)
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FILED', 'PAID')),
  filing_reference  text,
  filed_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, year, month)
);
CREATE INDEX payroll_declaration_tenant_idx ON payroll_declaration(tenant_id, year, month);

-- ---------------------------------------------------------------------------
-- Clés de données par dossier (chiffrement par enveloppe, docs/SECURITY.md §7)
-- La clé de données (AES-256) d'un dossier est stockée enveloppée par la clé
-- maître (PAYROLL_ENCRYPTION_KEY ou KMS) : la base seule ne permet pas de
-- déchiffrer. La rotation crée une version ACTIVE et re-chiffre les champs.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_tenant_key (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version >= 1),
  wrapped_key    text NOT NULL,                                     -- clé de données enveloppée
  master_key_id  text NOT NULL,                                     -- identifiant de la clé maître (env, KMS…)
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz,
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX payroll_tenant_key_active_idx ON payroll_tenant_key(tenant_id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Row-Level Security et droits du rôle applicatif
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee', 'payroll_run', 'payslip', 'payroll_declaration', 'payroll_tenant_key'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON employee, payroll_run, payslip, payroll_declaration TO arcompt_app;
GRANT SELECT, INSERT, UPDATE ON payroll_tenant_key TO arcompt_app; -- jamais de suppression de clé par l'application
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
