# Publish schema preview — reference only

This is the exact **13-statement read-only preview** captured from Replit's
non-interactive development-to-production schema diff. It is **not an approved
migration** and must not be pasted into a SQL runner. The actual Publish flow
may offer different conflict-resolution choices; refresh and review its diff
before any private test. These statements would create the job tables with
unconditioned policies and leave the security repair incomplete.

```sql
-- Publish statement 1
CREATE TABLE "background_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"backoff_ms" integer DEFAULT 1000 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_job_tenant_id_name_dedupe_key_key" UNIQUE("tenant_id","name","dedupe_key"),
	CONSTRAINT "background_job_backoff_ms_check" CHECK ((backoff_ms >= 0) AND (backoff_ms <= 60000)),
	CONSTRAINT "background_job_max_attempts_check" CHECK ((max_attempts >= 1) AND (max_attempts <= 10)),
	CONSTRAINT "background_job_name_check" CHECK (name = ANY (ARRAY['document.extract'::text, 'import.statement'::text, 'dunning.send'::text])),
	CONSTRAINT "background_job_status_check" CHECK (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'DONE'::text, 'FAILED'::text]))
);

-- Publish statement 2
ALTER TABLE "background_job" ENABLE ROW LEVEL SECURITY;

-- Publish statement 3
CREATE TABLE "background_job_review" (
	"source_job_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"replacement_job_id" uuid,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_job_review_outcome_check" CHECK (outcome = ANY (ARRAY['DELIVERED'::text, 'NOT_DELIVERED'::text]))
);

-- Publish statement 4
ALTER TABLE "background_job_review" ENABLE ROW LEVEL SECURITY;

-- Publish statement 5
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;

-- Publish statement 6
ALTER TABLE "background_job_review" ADD CONSTRAINT "background_job_review_replacement_job_id_fkey" FOREIGN KEY ("replacement_job_id") REFERENCES "public"."background_job"("id") ON DELETE no action ON UPDATE no action;

-- Publish statement 7
ALTER TABLE "background_job_review" ADD CONSTRAINT "background_job_review_source_job_id_fkey" FOREIGN KEY ("source_job_id") REFERENCES "public"."background_job"("id") ON DELETE cascade ON UPDATE no action;

-- Publish statement 8
ALTER TABLE "background_job_review" ADD CONSTRAINT "background_job_review_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;

-- Publish statement 9
CREATE INDEX "background_job_ready_idx" ON "background_job" USING btree ("run_at") WHERE (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));

-- Publish statement 10
CREATE POLICY "background_job_owner" ON "background_job" AS PERMISSIVE FOR ALL TO public;

-- Publish statement 11
CREATE POLICY "tenant_isolation" ON "background_job" AS PERMISSIVE FOR ALL TO public;

-- Publish statement 12
CREATE POLICY "background_job_review_owner" ON "background_job_review" AS PERMISSIVE FOR ALL TO public;

-- Publish statement 13
CREATE POLICY "tenant_isolation" ON "background_job_review" AS PERMISSIVE FOR ALL TO public;
```