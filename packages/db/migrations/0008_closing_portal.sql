-- ARCOMPT — clôture, workflow d'exercice, portail cabinet
-- ===== closing =====

-- Liste de contrôle de clôture : mensuelle (period_id renseigné) ou annuelle (period_id NULL).
CREATE TABLE closing_checklist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fiscal_year_id  uuid NOT NULL REFERENCES fiscal_year(id) ON DELETE CASCADE,
  period_id       uuid REFERENCES period(id) ON DELETE CASCADE,
  item_key        text NOT NULL,                       -- clé stable du gabarit (bank_reconciled, vat_declared…)
  label           text NOT NULL,
  blocking        boolean NOT NULL DEFAULT true,       -- un item bloquant TODO empêche la clôture
  status          text NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'DONE', 'NA')),
  done_by         uuid,
  done_at         timestamptz,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- justification : ids de pièces, commentaire, soldes constatés
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX closing_checklist_unique_idx ON closing_checklist(tenant_id, fiscal_year_id, coalesce(period_id, '00000000-0000-0000-0000-000000000000'::uuid), item_key);
CREATE INDEX closing_checklist_tenant_idx ON closing_checklist(tenant_id, fiscal_year_id, period_id);

-- Workflow de l'exercice (ARCHITECTURE.md §10) : Tenue → Révision → États → Visa → Dépôt → Verrouillé.
CREATE TABLE fiscal_year_workflow (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fiscal_year_id              uuid NOT NULL REFERENCES fiscal_year(id) ON DELETE CASCADE,
  state                       text NOT NULL DEFAULT 'TENUE' CHECK (state IN ('TENUE', 'REVISION', 'ETATS', 'VISA', 'DEPOT', 'VERROUILLE')),
  history                     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ from, to, by, at, comment }]
  reviewer_id                 uuid,                                -- qui a soumis au visa
  approver_id                 uuid,                                -- qui a visé (REVIEWER / OWNER)
  filing_receipt_document_id  uuid REFERENCES document(id),        -- accusé de dépôt DGI, requis pour verrouiller
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_year_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['closing_checklist', 'fiscal_year_workflow'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON closing_checklist, fiscal_year_workflow TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;

-- ===== portal (ajouté par le module portail) =====
-- Portail cabinets : invitations, commentaires, demandes de pièces, dépôts,
-- abonnements et marque blanche, compteurs d'usage. Deux niveaux d'isolation :
--  - tables « dossier »      : tenant_id + politique tenant_isolation (app_tenant_id()) ;
--  - tables « organisation » : organization_id + politique sur app_organization_id().

-- ---------------------------------------------------------------------------
-- Organisation : exigence MFA. Un cabinet (kind = FIRM) l'exige toujours ;
-- pour les autres, le drapeau est réglable (voir OrganizationService).
-- ---------------------------------------------------------------------------
ALTER TABLE organization ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;
UPDATE organization SET mfa_required = true WHERE kind = 'FIRM' AND NOT mfa_required;

-- Organisation d'un dossier : en mode dev le jeton ne porte pas d'organisation,
-- l'API la résout depuis le dossier courant. SECURITY DEFINER mais limitée au
-- tenant du contexte : ne révèle rien sur un autre dossier.
CREATE OR REPLACE FUNCTION organization_of_company(tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM company WHERE id = tenant AND id = app_tenant_id()
$$;
REVOKE ALL ON FUNCTION organization_of_company(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organization_of_company(uuid) TO arcompt_app;

-- ---------------------------------------------------------------------------
-- Invitations (niveau organisation). Le jeton n'est jamais stocké : seul son
-- hash SHA-256 l'est ; company_ids liste les dossiers auxquels l'invité sera
-- rattaché avec le rôle indiqué.
-- ---------------------------------------------------------------------------
CREATE TABLE invitation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email            text NOT NULL,
  role             text NOT NULL CHECK (role IN ('OWNER', 'ACCOUNTANT', 'CASHIER', 'AUDITOR', 'REVIEWER')),
  company_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(company_ids) = 'array')
);
CREATE INDEX invitation_organization_idx ON invitation(organization_id, email);

-- Lecture d'une invitation par le hash de son jeton : l'invité n'appartient pas
-- encore à l'organisation, la RLS ne lui montrerait rien. Le jeton est secret,
-- son hash suffit à prouver la légitimité de la lecture.
CREATE OR REPLACE FUNCTION invitation_by_token_hash(p_hash text)
RETURNS TABLE (id uuid, organization_id uuid, email text, role text, company_ids jsonb, expires_at timestamptz, accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.organization_id, i.email, i.role, i.company_ids, i.expires_at, i.accepted_at
    FROM invitation i WHERE i.token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION invitation_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_by_token_hash(text) TO arcompt_app;

-- ---------------------------------------------------------------------------
-- Commentaires de collaboration (niveau dossier), rattachés à une entité.
-- ---------------------------------------------------------------------------
CREATE TABLE company_comment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  entity_kind  text NOT NULL CHECK (entity_kind IN ('ENTRY', 'DOCUMENT', 'PROPOSAL', 'PERIOD', 'FISCAL_YEAR')),
  entity_id    uuid NOT NULL,
  author_id    uuid NOT NULL,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  resolved     boolean NOT NULL DEFAULT false,
  resolved_by  uuid,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_comment_entity_idx ON company_comment(tenant_id, entity_kind, entity_id, created_at);
CREATE INDEX company_comment_open_idx ON company_comment(tenant_id) WHERE NOT resolved;

-- ---------------------------------------------------------------------------
-- Demandes de pièces manquantes (niveau dossier), envoyées par WhatsApp ou e-mail.
-- ---------------------------------------------------------------------------
CREATE TABLE missing_document_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  partner_id            uuid REFERENCES partner(id),
  entry_id              uuid REFERENCES journal_entry(id),
  description           text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  channel               text NOT NULL CHECK (channel IN ('WHATSAPP', 'EMAIL')),
  recipient             text NOT NULL,                -- numéro WhatsApp ou adresse e-mail
  requested_by          uuid NOT NULL,
  sent_at               timestamptz,
  received_document_id  uuid REFERENCES document(id),
  received_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX missing_document_request_tenant_idx ON missing_document_request(tenant_id, created_at);
CREATE INDEX missing_document_request_open_idx ON missing_document_request(tenant_id) WHERE received_document_id IS NULL;

-- ---------------------------------------------------------------------------
-- Dépôts (DSF, TVA, social) : fichier au format du portail, puis accusé.
-- PREPARED → FILED (déposé) → ACKNOWLEDGED (accusé joint).
-- ---------------------------------------------------------------------------
CREATE TABLE filing (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fiscal_year_id       uuid NOT NULL REFERENCES fiscal_year(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('DSF', 'VAT', 'SOCIAL')),
  portal_name          text NOT NULL,
  format               text NOT NULL CHECK (format IN ('XLSX', 'XML', 'PDF', 'CSV', 'MANUAL')),
  period_label         text,                          -- ex. « 2025-03 » pour une TVA mensuelle
  file_document_id     uuid REFERENCES document(id),
  receipt_document_id  uuid REFERENCES document(id),
  status               text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED', 'FILED', 'ACKNOWLEDGED')),
  prepared_by          uuid NOT NULL,
  filed_at             timestamptz,
  acknowledged_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PREPARED') = (filed_at IS NULL)),
  CHECK (status <> 'ACKNOWLEDGED' OR receipt_document_id IS NOT NULL)
);
CREATE INDEX filing_tenant_idx ON filing(tenant_id, fiscal_year_id, kind);

-- ---------------------------------------------------------------------------
-- Tarification. subscription_plan est un catalogue global (lecture seule pour
-- l'application) ; organization_subscription porte le plan choisi, les
-- surcharges tarifaires et la marque blanche d'une organisation.
-- degressive_tiers : [{ "upTo": 5, "price": "12000" }, { "price": "8000" }]
-- (dernier palier sans upTo = au-delà). Tarif « volume » : tous les dossiers
-- au prix du palier atteint ; « tiered » : prix marginal par palier.
-- white_label : { brandName, logoDocumentId, colours: { primary, accent }, senderName }
-- quotas : { aiCalls, documents, whatsappMessages } par dossier et par mois.
-- ---------------------------------------------------------------------------
CREATE TABLE subscription_plan (
  code               text PRIMARY KEY,
  label              text NOT NULL,
  currency           char(3) NOT NULL DEFAULT 'XOF',
  price_per_dossier  numeric(20,4) NOT NULL DEFAULT 0 CHECK (price_per_dossier >= 0),
  degressive_tiers   jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_mode       text NOT NULL DEFAULT 'VOLUME' CHECK (pricing_mode IN ('VOLUME', 'TIERED')),
  quotas             jsonb NOT NULL DEFAULT '{}'::jsonb,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(degressive_tiers) = 'array')
);

-- Valeurs indicatives, à ajuster commercialement.
INSERT INTO subscription_plan (code, label, currency, price_per_dossier, degressive_tiers, quotas) VALUES
  ('TRIAL', 'Essai', 'XOF', 0, '[]', '{"aiCalls": 50, "documents": 100, "whatsappMessages": 50}'),
  ('PME', 'PME en direct', 'XOF', 15000, '[]', '{"aiCalls": 500, "documents": 1000, "whatsappMessages": 300}'),
  ('CABINET', 'Cabinet', 'XOF', 12000,
     '[{"upTo": 5, "price": "12000"}, {"upTo": 20, "price": "10000"}, {"upTo": 50, "price": "8000"}, {"price": "6000"}]',
     '{"aiCalls": 1000, "documents": 2000, "whatsappMessages": 500}');

CREATE TABLE organization_subscription (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL UNIQUE REFERENCES organization(id) ON DELETE CASCADE,
  plan_code          text NOT NULL REFERENCES subscription_plan(code),
  price_per_dossier  numeric(20,4) CHECK (price_per_dossier IS NULL OR price_per_dossier >= 0), -- surcharge du plan
  degressive_tiers   jsonb,                                                                    -- surcharge du plan
  pricing_mode       text CHECK (pricing_mode IS NULL OR pricing_mode IN ('VOLUME', 'TIERED')),
  white_label        jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at         date NOT NULL DEFAULT current_date,
  ended_at           date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (degressive_tiers IS NULL OR jsonb_typeof(degressive_tiers) = 'array'),
  CHECK (jsonb_typeof(white_label) = 'object')
);

-- ---------------------------------------------------------------------------
-- Compteurs d'usage mensuels par dossier (quotas). month = 'AAAA-MM'.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_counter (
  tenant_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  month              char(7) NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  ai_calls           integer NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  documents          integer NOT NULL DEFAULT 0 CHECK (documents >= 0),
  whatsapp_messages  integer NOT NULL DEFAULT 0 CHECK (whatsapp_messages >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);

-- ---------------------------------------------------------------------------
-- Tableau de bord multi-dossiers : une ligne jsonb par dossier de l'organisation.
-- SECURITY DEFINER pour agréger tous les dossiers en une requête, mais refuse
-- toute organisation autre que celle du contexte (app_organization_id()).
-- Les tables d'autres modules (ai_proposal, fiscal_year_workflow) sont
-- interrogées seulement si elles existent (to_regclass) ; sinon la clé vaut null.
-- anomalies = brouillons de plus de 30 jours + périodes encore ouvertes plus
-- de 60 jours après leur fin.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_dashboard(p_organization_id uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c record;
  v_has_proposals boolean;
  v_has_workflow boolean;
  v_workflow_col text;
  v_last_entry date;
  v_drafts integer;
  v_validated integer;
  v_proposals integer;
  v_open_periods integer;
  v_fy record;
  v_workflow text;
  v_stale_drafts integer;
  v_stale_periods integer;
  v_comments integer;
  v_missing integer;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM app_organization_id() THEN
    RAISE EXCEPTION 'ARCOMPT: organisation non autorisée' USING ERRCODE = '42501';
  END IF;

  v_has_proposals := to_regclass('public.ai_proposal') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_proposal' AND column_name = 'status')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_proposal' AND column_name = 'tenant_id');
  v_has_workflow := to_regclass('public.fiscal_year_workflow') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fiscal_year_workflow' AND column_name = 'fiscal_year_id');
  IF v_has_workflow THEN
    SELECT column_name INTO v_workflow_col FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fiscal_year_workflow' AND column_name IN ('state', 'status')
      ORDER BY CASE column_name WHEN 'state' THEN 0 ELSE 1 END LIMIT 1;
    v_has_workflow := v_workflow_col IS NOT NULL;
  END IF;

  FOR c IN SELECT * FROM company WHERE organization_id = p_organization_id ORDER BY name, id LOOP
    SELECT max(entry_date) INTO v_last_entry FROM journal_entry WHERE tenant_id = c.id AND status = 'VALIDATED';
    SELECT count(*) FILTER (WHERE status = 'DRAFT')::int, count(*) FILTER (WHERE status = 'VALIDATED')::int,
           count(*) FILTER (WHERE status = 'DRAFT' AND created_at < now() - interval '30 days')::int
      INTO v_drafts, v_validated, v_stale_drafts
      FROM journal_entry WHERE tenant_id = c.id;
    SELECT count(*)::int, count(*) FILTER (WHERE end_date < current_date - 60)::int
      INTO v_open_periods, v_stale_periods
      FROM period WHERE tenant_id = c.id AND status = 'OPEN';
    SELECT id, code, status, start_date, end_date INTO v_fy FROM fiscal_year
      WHERE tenant_id = c.id ORDER BY (status = 'OPEN') DESC, start_date DESC LIMIT 1;
    SELECT count(*)::int INTO v_comments FROM company_comment WHERE tenant_id = c.id AND NOT resolved;
    SELECT count(*)::int INTO v_missing FROM missing_document_request WHERE tenant_id = c.id AND received_document_id IS NULL;

    v_proposals := NULL;
    IF v_has_proposals THEN
      EXECUTE 'SELECT count(*)::int FROM ai_proposal WHERE tenant_id = $1 AND status = ''PENDING''' INTO v_proposals USING c.id;
    END IF;
    v_workflow := NULL;
    IF v_has_workflow AND v_fy.id IS NOT NULL THEN
      EXECUTE format('SELECT %I::text FROM fiscal_year_workflow WHERE fiscal_year_id = $1 LIMIT 1', v_workflow_col) INTO v_workflow USING v_fy.id;
    END IF;

    RETURN NEXT jsonb_build_object(
      'companyId', c.id,
      'name', c.name,
      'countryCode', c.country_code,
      'currency', c.currency,
      'accountingSystem', c.accounting_system,
      'packVersion', c.pack_version,
      'lastEntryDate', v_last_entry,
      'draftCount', v_drafts,
      'validatedCount', v_validated,
      'pendingProposals', v_proposals,
      'openPeriods', v_open_periods,
      'fiscalYear', CASE WHEN v_fy.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_fy.id, 'code', v_fy.code, 'status', v_fy.status, 'startDate', v_fy.start_date, 'endDate', v_fy.end_date) END,
      'workflowState', v_workflow,
      'anomalies', v_stale_drafts + v_stale_periods,
      'unresolvedComments', v_comments,
      'missingDocuments', v_missing
    );
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION portal_dashboard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_dashboard(uuid) TO arcompt_app;

-- ---------------------------------------------------------------------------
-- RLS et droits.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_comment', 'missing_document_request', 'filing', 'usage_counter'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invitation', 'organization_subscription'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY organization_isolation ON %I USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id())', t);
  END LOOP;
END $$;

-- Catalogue de plans : lisible par tous, modifiable hors application.
ALTER TABLE subscription_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_plan_read ON subscription_plan FOR SELECT USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON invitation, company_comment, missing_document_request, filing, organization_subscription, usage_counter TO arcompt_app;
GRANT SELECT ON subscription_plan TO arcompt_app;
REVOKE INSERT, UPDATE, DELETE ON subscription_plan FROM arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;

-- ---------------------------------------------------------------------------
-- Identités et accès (SECURITY.md §4) : cycle de vie des comptes, accès
-- administrateur journalisé et notifié, accès d'urgence (break-glass).
-- ---------------------------------------------------------------------------
-- Activité et suspension : suspension après 90 jours d'inactivité (OrganizationService.suspendInactiveAccounts).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS suspended_reason text;

-- Une invitation vit au plus 7 jours.
ALTER TABLE invitation ADD CONSTRAINT invitation_max_ttl CHECK (expires_at <= created_at + interval '7 days');

-- Accès d'urgence : demandé par un administrateur, approuvé par un second
-- (approver_id <> requester_id), valable au plus 4 heures, tout est dans audit_log.
CREATE TABLE break_glass_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  requester_id  uuid NOT NULL,
  approver_id   uuid,
  reason        text NOT NULL CHECK (length(reason) BETWEEN 5 AND 2000),
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (approver_id IS NULL OR approver_id <> requester_id),
  CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '4 hours'),
  CHECK ((status IN ('APPROVED', 'REJECTED', 'REVOKED')) = (decided_at IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR approver_id IS NOT NULL)
);
CREATE INDEX break_glass_request_tenant_idx ON break_glass_request(tenant_id, status, expires_at);

-- Journal des accès administrateur à un dossier : insertion seule, chaque
-- accès notifie les dirigeants (OWNER) du dossier.
CREATE TABLE admin_access_log (
  id                      bigserial PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  admin_user_id           uuid NOT NULL,
  reason                  text NOT NULL CHECK (length(reason) BETWEEN 5 AND 2000),
  break_glass_request_id  uuid REFERENCES break_glass_request(id),
  notified_count          integer NOT NULL DEFAULT 0,
  notified_at             timestamptz,
  accessed_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_access_log_tenant_idx ON admin_access_log(tenant_id, accessed_at DESC);

-- Seules les colonnes de notification peuvent changer après insertion.
CREATE OR REPLACE FUNCTION admin_access_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ARCOMPT: DELETE interdit sur admin_access_log' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.admin_user_id <> OLD.admin_user_id OR NEW.reason <> OLD.reason
     OR NEW.break_glass_request_id IS DISTINCT FROM OLD.break_glass_request_id OR NEW.accessed_at <> OLD.accessed_at THEN
    RAISE EXCEPTION 'ARCOMPT: modification interdite sur admin_access_log' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_access_log_guard_trg BEFORE UPDATE OR DELETE ON admin_access_log
  FOR EACH ROW EXECUTE FUNCTION admin_access_log_guard();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['break_glass_request', 'admin_access_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON break_glass_request TO arcompt_app;
GRANT SELECT, INSERT, UPDATE ON admin_access_log TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
