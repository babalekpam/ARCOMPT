-- SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
-- SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-- ARCOMPT — pièces, capture IA, file de revue, règles de catégorisation, WhatsApp, relances.
-- L'IA propose, l'humain valide : une ai_proposal n'atteint le grand livre qu'après
-- validation (status VALIDATED / CORRECTED) par Ledger.post(source = 'AI').

-- ---------------------------------------------------------------------------
-- Pièces : nom d'origine, origine du dépôt, état de la lecture.
-- ---------------------------------------------------------------------------
ALTER TABLE document ADD COLUMN IF NOT EXISTS filename text;
ALTER TABLE document ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'UPLOAD' CHECK (source IN ('UPLOAD', 'WHATSAPP', 'EMAIL', 'BANK'));
ALTER TABLE document ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED', 'EXTRACTED', 'NEEDS_OCR', 'PROPOSED', 'POSTED', 'REJECTED'));
CREATE INDEX IF NOT EXISTS document_tenant_status_idx ON document(tenant_id, status, created_at DESC);
-- Clé de doublon (tiers|montant|date) calculée par l'extraction, indexée pour la détection.
CREATE INDEX IF NOT EXISTS document_duplicate_key_idx ON document(tenant_id, (extracted->>'duplicate_key')) WHERE extracted ? 'duplicate_key';

-- ---------------------------------------------------------------------------
-- Règles de catégorisation du dossier : motif (expression régulière insensible
-- à la casse, ou simple sous-chaîne) → compte. Premier étage du pipeline.
-- ---------------------------------------------------------------------------
CREATE TABLE categorization_rule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  pattern         text NOT NULL,
  account_number  text NOT NULL CHECK (account_number ~ '^[1-9][0-9]{1,12}$'),
  vat_code        text,
  label           text,
  priority        integer NOT NULL DEFAULT 100,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categorization_rule_tenant_idx ON categorization_rule(tenant_id, active, priority);

-- Mémoire : jetons normalisés du libellé pour la recherche par recouvrement
-- quand pgvector est absent (colonne embedding facultative, cf. 0002).
ALTER TABLE categorization_memory ADD COLUMN IF NOT EXISTS tokens text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS categorization_memory_tokens_idx ON categorization_memory USING gin (tokens);

-- ---------------------------------------------------------------------------
-- Propositions IA
-- ---------------------------------------------------------------------------
CREATE TABLE ai_proposal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES document(id) ON DELETE SET NULL,
  source        text NOT NULL CHECK (source IN ('UPLOAD', 'WHATSAPP', 'EMAIL', 'BANK')),
  kind          text NOT NULL CHECK (kind IN ('ENTRY', 'CATEGORIZATION', 'MATCH')),
  extraction    jsonb,                          -- DocumentExtraction (ou saisie texte normalisée)
  proposal      jsonb NOT NULL,                 -- EntryProposal (+ partner_id par ligne)
  confidence    numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  guard_issues  jsonb NOT NULL DEFAULT '[]'::jsonb,
  route         text NOT NULL CHECK (route IN ('ONE_TAP_VALIDATION', 'REVIEW_QUEUE', 'REJECTED')),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VALIDATED', 'CORRECTED', 'REJECTED')),
  decided_by    uuid,
  decided_at    timestamptz,
  entry_id      uuid REFERENCES journal_entry(id),
  correction    jsonb,                          -- lignes corrigées par l'humain
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('VALIDATED', 'CORRECTED')) = (entry_id IS NOT NULL))
);
CREATE INDEX ai_proposal_tenant_status_idx ON ai_proposal(tenant_id, status, route, created_at DESC);
CREATE INDEX ai_proposal_document_idx ON ai_proposal(tenant_id, document_id);
CREATE INDEX ai_proposal_duplicate_key_idx ON ai_proposal(tenant_id, (extraction->>'duplicate_key')) WHERE extraction ? 'duplicate_key';

-- ---------------------------------------------------------------------------
-- WhatsApp : conversations et messages. Le numéro est lié à un dossier et un
-- utilisateur ; tant qu'il n'est pas lié, tenant_id est NULL et la ligne n'est
-- visible d'aucun dossier (la RLS exige tenant_id = app_tenant_id()).
-- ---------------------------------------------------------------------------
CREATE TABLE whatsapp_conversation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES company(id) ON DELETE CASCADE,
  phone            text NOT NULL UNIQUE,         -- E.164 sans '+', tel que Meta le fournit
  user_id          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  state            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Dernière session authentifiée dans l'application pour ce numéro : les
  -- actions sensibles (validation) exigent verified_at < 24 h.
  verified_at      timestamptz,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_conversation_tenant_idx ON whatsapp_conversation(tenant_id, last_message_at DESC);

CREATE TABLE whatsapp_message (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES whatsapp_conversation(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  provider_id      text,
  type             text NOT NULL CHECK (type IN ('TEXT', 'IMAGE', 'AUDIO', 'DOCUMENT', 'INTERACTIVE')),
  body             jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposal_id      uuid REFERENCES ai_proposal(id) ON DELETE SET NULL,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_message_conversation_idx ON whatsapp_message(tenant_id, conversation_id, at DESC);
CREATE UNIQUE INDEX whatsapp_message_provider_idx ON whatsapp_message(provider_id) WHERE provider_id IS NOT NULL;

-- Résolution d'un numéro vers son dossier, sans contexte tenant (webhook).
-- SECURITY DEFINER limité à ce seul besoin : ne renvoie que les identifiants,
-- jamais l'état de la conversation.
CREATE OR REPLACE FUNCTION whatsapp_resolve_phone(p_phone text)
RETURNS TABLE (tenant_id uuid, user_id uuid, conversation_id uuid, verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.user_id, c.id, c.verified_at
    FROM whatsapp_conversation c
   WHERE c.phone = regexp_replace(p_phone, '[^0-9]', '', 'g') AND c.tenant_id IS NOT NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION whatsapp_resolve_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_resolve_phone(text) TO arcompt_app;

-- Anti-rejeu du webhook : identifiants de messages déjà traités (aucune donnée
-- métier, pas de tenant : la table est consultée avant toute résolution).
CREATE TABLE whatsapp_webhook_receipt (
  provider_id  text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON whatsapp_webhook_receipt TO arcompt_app;

-- ---------------------------------------------------------------------------
-- Relances (journal d'envoi, alimenté par la tâche dunning.send)
-- ---------------------------------------------------------------------------
CREATE TABLE dunning_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  partner_id  uuid REFERENCES partner(id) ON DELETE SET NULL,
  reference   text,                              -- facture ou dossier relancé
  channel     text NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP', 'SMS')),
  level       smallint NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'FAILED', 'SKIPPED')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dunning_log_tenant_idx ON dunning_log(tenant_id, sent_at DESC);

-- ---------------------------------------------------------------------------
-- RLS + droits
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categorization_rule', 'ai_proposal', 'whatsapp_conversation', 'whatsapp_message', 'dunning_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON categorization_rule, ai_proposal, whatsapp_conversation, whatsapp_message, dunning_log TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
