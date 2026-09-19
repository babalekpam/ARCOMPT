-- Mémoire des catégorisations (pgvector). L'extension est facultative en local :
-- si elle manque, la table est créée sans colonne vectorielle et la recherche
-- sémantique est désactivée (la catégorisation retombe sur les règles).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ARCOMPT: extension pgvector indisponible, recherche sémantique désactivée';
  END;
END $$;

CREATE TABLE ai_call_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  user_id        uuid,
  capability     text NOT NULL,        -- capture, categorize, reconcile, assistant, narrative
  model          text NOT NULL,
  prompt_version text NOT NULL,
  input          jsonb NOT NULL,       -- après minimisation des données
  output         jsonb,
  schema_valid   boolean,
  confidence     numeric(5,4),
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_call_log_tenant_idx ON ai_call_log(tenant_id, at DESC);

CREATE TABLE categorization_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  partner_name    text,
  description     text NOT NULL,
  account_number  text NOT NULL,
  vat_code        text,
  source          text NOT NULL CHECK (source IN ('HUMAN_CORRECTION', 'HUMAN_VALIDATION')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categorization_memory_tenant_idx ON categorization_memory(tenant_id, partner_name);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE categorization_memory ADD COLUMN embedding vector(1024)';
  END IF;
END $$;

ALTER TABLE ai_call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_call_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_call_log USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE categorization_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorization_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON categorization_memory USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_call_log, categorization_memory TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
REVOKE UPDATE, DELETE ON ai_call_log FROM arcompt_app;
