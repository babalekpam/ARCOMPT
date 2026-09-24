#!/usr/bin/env bash
#
# Rehearse the captured private-publish diff in a disposable PostgreSQL 16
# cluster.  This intentionally stops at the preview: it does not repair the
# simulated production gaps.
set -Eeuo pipefail

for forbidden in DATABASE_URL PGHOST PGPORT PGPASSWORD PGSERVICE; do
  if [[ -n "${!forbidden-}" ]]; then
    printf 'refusing to run: %s is set (this rehearsal only accepts local PostgreSQL)\n' "$forbidden" >&2
    exit 2
  fi
done

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/packages/db/migrations"
PREVIEW="$ROOT/docs/PRIVATE-PUBLISH-PREVIEW.md"
for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null || { printf 'missing PostgreSQL 16 tool: %s\n' "$bin" >&2; exit 2; }
done
[[ -f "$PREVIEW" ]] || { printf 'missing preview: %s\n' "$PREVIEW" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/arcompt-private-publish.XXXXXX")"
DATA="$WORK/data"
SOCKET="$WORK/socket"
PORT="$((49152 + (BASHPID % 16384)))"
PGPID=""
cleanup() {
  if [[ -n "$PGPID" ]]; then
    pg_ctl -D "$DATA" -w stop -m immediate >/dev/null 2>&1 || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT INT TERM
mkdir "$SOCKET"

initdb -D "$DATA" --no-locale --encoding=UTF8 --auth=trust >/dev/null
pg_ctl -D "$DATA" -o "-k $SOCKET -p $PORT" -w start >/dev/null
PGPID=started
export PGHOST="$SOCKET" PGPORT="$PORT" PGUSER="$(id -un)" PGDATABASE=postgres

psql_local() { psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 "$@"; }
printf '%s\n' "temporary local cluster: PostgreSQL $(psql_local -Atqc 'SHOW server_version_num')"
psql_local -c 'CREATE ROLE neondb_owner LOGIN NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB' >/dev/null
psql_local -c 'CREATE DATABASE arcompt_rehearsal OWNER neondb_owner' >/dev/null
export PGUSER=neondb_owner PGDATABASE=arcompt_rehearsal

# 0001--0023 are the synthetic starting schema.  Applying files directly,
# rather than the application client, keeps this rehearsal independent of any
# development or production URL.
psql_local -c 'CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())' >/dev/null
for i in $(seq 1 23); do
  printf -v n '%04d' "$i"
  file="$(find "$MIGRATIONS" -maxdepth 1 -type f -name "${n}_*.sql" -print -quit)"
  [[ -n "$file" ]] || { printf 'missing source migration %s\n' "$n" >&2; exit 1; }
  psql_local -f "$file" >/dev/null
done

# Make the starting catalog look like the observed incomplete production
# snapshot: policies exist but are unconditioned, FORCE RLS was lost, twelve
# non-trigger functions are absent, and the audit immutability trigger is gone.
psql_local <<'SQL' >/dev/null
ALTER TABLE onboarding_bootstrap NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admin NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit NO FORCE ROW LEVEL SECURITY;
DROP POLICY onboarding_bootstrap_access ON onboarding_bootstrap;
CREATE POLICY onboarding_bootstrap_access ON onboarding_bootstrap;
DROP POLICY platform_admin_internal ON platform_admin;
CREATE POLICY platform_admin_internal ON platform_admin;
DROP POLICY platform_admin_audit_internal ON platform_admin_audit;
CREATE POLICY platform_admin_audit_internal ON platform_admin_audit;
DROP TRIGGER platform_admin_audit_immutable ON platform_admin_audit;
SQL

# These are deliberately explicit signatures: this is the catalog gap being
# rehearsed, not a repair candidate. CASCADE is confined to the disposable DB.
missing_functions=(
  'platform_admin_identity(text)'
  'platform_admin_company(text,uuid)'
  'platform_admin_companies(text)'
  'platform_admin_record_access(text,uuid,text,text)'
  'auth_bootstrap_lookup(text,text)'
  'auth_bootstrap_replay(text)'
  'background_job_claim(text[])'
  'background_job_renew(uuid,uuid)'
  'background_job_finish(uuid,uuid,text)'
  'background_job_expire_reminders()'
  'background_job_retry_internal(uuid)'
  'background_job_review_reminder(uuid,uuid,text)'
)
for signature in "${missing_functions[@]}"; do
  psql_local -v sig="$signature" -c "DROP FUNCTION IF EXISTS public.$signature CASCADE" >/dev/null
done

# Remove application grants and disposable group roles where possible.  The
# migrations create arcompt_app as NOLOGIN; queue is not present in 0001--0023.
psql_local -c 'GRANT arcompt_app TO neondb_owner' >/dev/null
psql_local <<'SQL' >/dev/null
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'arcompt_app'::regrole)
      OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = 'arcompt_app'::regrole)
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = 'arcompt_app'::regrole)
    THEN RAISE EXCEPTION 'simulation cannot drop a role that owns objects'; END IF;
    DROP OWNED BY arcompt_app;
    DROP ROLE arcompt_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_queue') THEN
    DROP ROLE arcompt_queue;
  END IF;
END $$;
SQL

# Baseline assertions fail loudly if the rehearsal no longer describes the
# intended production-shaped gap.
baseline="$(psql_local -Atqc "
SELECT
 (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN
   ('onboarding_bootstrap','platform_admin','platform_admin_audit')
   AND qual IS NULL AND with_check IS NULL),
 (SELECT count(*) FROM pg_class WHERE relname IN
   ('onboarding_bootstrap','platform_admin','platform_admin_audit')
   AND relforcerowsecurity IS FALSE),
 (SELECT count(*) FROM pg_proc WHERE oid IN
   (to_regprocedure('platform_admin_identity(text)'),
    to_regprocedure('platform_admin_company(text,uuid)'),
    to_regprocedure('platform_admin_companies(text)'),
    to_regprocedure('platform_admin_record_access(text,uuid,text,text)'),
    to_regprocedure('auth_bootstrap_lookup(text,text)'),
     to_regprocedure('auth_bootstrap_replay(text)'),
     to_regprocedure('background_job_claim(text[])'),
     to_regprocedure('background_job_renew(uuid,uuid)'),
     to_regprocedure('background_job_finish(uuid,uuid,text)'),
     to_regprocedure('background_job_expire_reminders()'),
     to_regprocedure('background_job_retry_internal(uuid)'),
     to_regprocedure('background_job_review_reminder(uuid,uuid,text)'))),
 (SELECT count(*) FROM pg_trigger WHERE tgname='platform_admin_audit_immutable'),
 (SELECT count(*) FROM pg_roles WHERE rolname IN ('arcompt_app','arcompt_queue'));
")"
[[ "$baseline" == "3|3|0|0|0" ]] || {
  printf 'baseline catalog assertion failed (expected bare_policies|no_force_rls|missing_functions|immutable_trigger|roles = 3|3|0|0|0; got %s)\n' "$baseline" >&2
  exit 1
}
printf '%s\n' "baseline catalog: 3 bare policies, 3 tables without FORCE RLS, 12 functions missing, immutable trigger missing, app/queue roles absent"

# Extract the exact fenced SQL from the reference document.  Keep this as a
# separate file so reviewers can inspect the command's input and substitute a
# reviewed repair candidate later, without this script applying one.
awk '
  /^```sql[[:space:]]*$/ { in_sql=1; next }
  in_sql && /^```[[:space:]]*$/ { exit }
  in_sql { print }
' "$PREVIEW" > "$WORK/preview.sql"
[[ "$(grep -c '^-- Publish statement ' "$WORK/preview.sql")" == 13 ]] || {
  printf 'preview extraction failed: expected 13 publish statements\n' >&2; exit 1;
}
psql_local -f "$WORK/preview.sql" >/dev/null

preview="$(psql_local -Atqc "
SELECT
 (SELECT count(*) FROM pg_class WHERE relname IN ('background_job','background_job_review')),
 (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('background_job','background_job_review')
   AND qual IS NULL AND with_check IS NULL),
 (SELECT count(*) FROM pg_constraint WHERE conname IN
   ('background_job_tenant_id_fkey','background_job_review_replacement_job_id_fkey',
    'background_job_review_source_job_id_fkey','background_job_review_tenant_id_fkey')),
 (SELECT count(*) FROM pg_class WHERE relname='background_job' AND relrowsecurity AND NOT relforcerowsecurity),
 (SELECT count(*) FROM pg_class WHERE relname='background_job_review' AND relrowsecurity AND NOT relforcerowsecurity);
")"
[[ "$preview" == "2|4|4|1|1" ]] || {
  printf 'preview catalog assertion failed (expected tables|bare_policies|foreign_keys|job_rls|review_rls = 2|4|4|1|1; got %s)\n' "$preview" >&2
  exit 1
}
printf '%s\n' "preview catalog: 13 statements applied; 2 job tables, 4 bare policies, 4 foreign keys, RLS enabled without FORCE"
if [[ "${REHEARSE_REPAIR:-0}" == 1 ]]; then
  candidate="$ROOT/docs/PRIVATE-PUBLISH-REPAIR-REVIEW.md"
  [[ -f "$candidate" ]] || { printf 'review candidate missing: %s\n' "$candidate" >&2; exit 1; }
  awk '/^```sql[[:space:]]*$/ { in_sql=1; next } in_sql && /^```[[:space:]]*$/ { exit } in_sql { print }' \
    "$candidate" > "$WORK/repair.sql"
  [[ "$(grep -c '^COMMIT;' "$WORK/repair.sql")" == 1 ]] || {
    printf 'repair must have exactly one final COMMIT\n' >&2; exit 1;
  }
  psql_local -f "$WORK/repair.sql" >/dev/null
  printf '%s\n' "review-only repair transaction: applied to isolated local PostgreSQL cluster"
  psql_local <<'SQL' >/dev/null
CREATE ROLE arcompt_app_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE arcompt_queue_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT arcompt_app TO arcompt_app_login;
GRANT arcompt_queue TO arcompt_queue_login;
SQL
  app_url="postgres://arcompt_app_login@127.0.0.1:$PORT/arcompt_rehearsal"
  LOCAL_APP_URL="$app_url" LOCAL_QUEUE_URL="postgres://arcompt_queue_login@127.0.0.1:$PORT/arcompt_rehearsal" corepack pnpm exec tsx -e '
    import { createDb } from "./packages/db/src/client.ts";
    import { assertProductionDatabaseSecurity } from "./apps/api/src/database-readiness.ts";
    import { assertProductionQueueDatabaseSecurity } from "./apps/api/src/queue-database.ts";
    (async () => {
      const db = createDb({ url: process.env.LOCAL_APP_URL, max: 2 });
      const queue = createDb({ url: process.env.LOCAL_QUEUE_URL, max: 1 });
      try {
        await assertProductionDatabaseSecurity(db);
        await assertProductionQueueDatabaseSecurity(queue, db);
        let rejected = false;
        try { await assertProductionQueueDatabaseSecurity(db, db); } catch { rejected = true; }
        if (!rejected) throw new Error("queue guard accepted the app connection");
        console.log("actual restricted queue-login startup guard and wrong-role rejection: PASS");
        console.log("actual restricted app-login startup guard: PASS");
      } finally { await queue.end(); await db.end(); }
    })().catch((e) => { console.error(e); process.exitCode = 1; });
  '
  if PGUSER=arcompt_queue_login psql_local -Atqc 'SELECT count(*) FROM public.background_job' >/dev/null 2>&1; then
    printf 'queue login has direct job-table access\n' >&2; exit 1
  fi
  if PGUSER=arcompt_app_login psql_local -Atqc "SELECT has_function_privilege(current_user, 'public.background_job_claim(text[])', 'EXECUTE')" |
    grep -qx f; then :; else printf 'app login can claim queue jobs\n' >&2; exit 1; fi
  PGUSER=arcompt_queue_login psql_local -Atqc "SELECT has_function_privilege(current_user, 'public.background_job_claim(text[])', 'EXECUTE')" |
    grep -qx t
  printf '%s\n' 'actual restricted queue-login grant and table-denial checks: PASS'
  # Exercise the repaired catalog with two synthetic companies. All rows stay
  # inside this disposable cluster.
  psql_local <<'SQL' >/dev/null
DO $$
DECLARE
  org_a uuid; org_b uuid; company_a uuid; company_b uuid;
  fy uuid; per uuid; jnl uuid; acc_a uuid; acc_b uuid; entry_id uuid;
BEGIN
  INSERT INTO organization(name) VALUES ('Rehearsal organization A') RETURNING id INTO org_a;
  INSERT INTO organization(name) VALUES ('Rehearsal organization B') RETURNING id INTO org_b;
  INSERT INTO company(organization_id, name, country_code, currency, pack_version)
    VALUES (org_a, 'Rehearsal company A', 'CI', 'XOF', 'rehearsal') RETURNING id INTO company_a;
  INSERT INTO company(organization_id, name, country_code, currency, pack_version)
    VALUES (org_b, 'Rehearsal company B', 'CI', 'XOF', 'rehearsal') RETURNING id INTO company_b;
  INSERT INTO background_job(tenant_id, name, payload, run_at)
    VALUES (company_a, 'document.extract', '{}'::jsonb, now() + interval '1 hour'),
           (company_b, 'document.extract', '{}'::jsonb, now() - interval '1 minute');
  INSERT INTO fiscal_year(tenant_id, code, start_date, end_date)
    VALUES (company_a, '2025', '2025-01-01', '2025-12-31') RETURNING id INTO fy;
  INSERT INTO period(tenant_id, fiscal_year_id, start_date, end_date)
    VALUES (company_a, fy, '2025-01-01', '2025-12-31') RETURNING id INTO per;
  INSERT INTO journal(tenant_id, code, label, type)
    VALUES (company_a, 'OD', 'Rehearsal journal', 'OD') RETURNING id INTO jnl;
  INSERT INTO account(tenant_id, number, label, class, nature)
    VALUES (company_a, '101', 'Capital', 1, 'PASSIF') RETURNING id INTO acc_a;
  INSERT INTO account(tenant_id, number, label, class, nature)
    VALUES (company_a, '601', 'Charges', 6, 'CHARGE') RETURNING id INTO acc_b;
  entry_id := gen_random_uuid();
  INSERT INTO journal_entry
    (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
    VALUES (entry_id, company_a, jnl, fy, per, '2025-01-02', 'Validated rehearsal entry',
            'MANUAL', gen_random_uuid());
  INSERT INTO journal_line
    (id, tenant_id, entry_id, line_no, account_id, label, debit, credit, currency)
    VALUES (gen_random_uuid(), company_a, entry_id, 1, acc_b, 'Debit', 100, 0, 'XOF'),
           (gen_random_uuid(), company_a, entry_id, 2, acc_a, 'Credit', 0, 100, 'XOF');
  UPDATE journal_entry SET status = 'VALIDATED', number = 1, hash = repeat('a', 64)
    WHERE id = entry_id;
  INSERT INTO platform_admin_audit(company_id, organization_id, method, path, event)
    VALUES (company_a, org_a, 'GET', '/rehearsal', 'ACCESS');
END $$;
SQL
  company_a="$(psql_local -Atqc "SELECT id::text FROM company WHERE name = 'Rehearsal company A'")"
  company_b="$(psql_local -Atqc "SELECT id::text FROM company WHERE name = 'Rehearsal company B'")"
  PGUSER=arcompt_app_login psql_local -v tenant_a="$company_a" <<'SQL' >/dev/null
SET app.tenant_id = :'tenant_a';
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM background_job
   WHERE tenant_id = (SELECT id FROM company WHERE name = 'Rehearsal company B');
  IF n <> 0 THEN RAISE EXCEPTION 'app selected a cross-tenant job row'; END IF;
  UPDATE background_job SET dedupe_key = 'cross-tenant-write'
   WHERE tenant_id = (SELECT id FROM company WHERE name = 'Rehearsal company B');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'app updated a cross-tenant job row'; END IF;
END $$;
SQL
  printf '%s\n' 'app tenant-context cross-tenant job SELECT/UPDATE denial: PASS'
  if PGUSER=arcompt_queue_login psql_local -Atqc 'SELECT count(*) FROM public.background_job' >/dev/null 2>&1; then
    printf 'queue login can SELECT background_job directly\n' >&2; exit 1
  fi
  queue_claim="$(PGUSER=arcompt_queue_login psql_local -Atqc \
    "SELECT tenant_id::text FROM public.background_job_claim(ARRAY['document.extract']) LIMIT 1")"
  [[ "$queue_claim" == "$company_b" ]] || {
    printf 'queue claim did not cross tenants (expected company B, got %s)\n' "$queue_claim" >&2; exit 1;
  }
  printf '%s\n' 'queue table SELECT denied while cross-tenant claim succeeds: PASS'
  if PGUSER=arcompt_app_login psql_local -v ON_ERROR_STOP=1 -c \
    "SET app.tenant_id = '$company_a'; UPDATE journal_entry SET label = 'tampered' WHERE label = 'Validated rehearsal entry';" \
    >/dev/null 2>&1; then
    printf 'app modified a validated journal entry\n' >&2; exit 1
  fi
  audit_id="$(psql_local -Atqc "SELECT id FROM platform_admin_audit WHERE path = '/rehearsal' LIMIT 1")"
  if PGUSER=arcompt_app_login psql_local -v ON_ERROR_STOP=1 -c \
    "UPDATE platform_admin_audit SET path = '/tampered' WHERE id = $audit_id" >/dev/null 2>&1; then
    printf 'app modified an immutable platform-admin audit row\n' >&2; exit 1
  fi
  if psql_local -Atqc "SELECT has_function_privilege('public', 'public.journal_entry_update_balances()', 'EXECUTE')" |
    grep -qx t; then
    printf 'public can execute journal_entry_update_balances\n' >&2; exit 1
  fi
  printf '%s\n' 'validated ledger/audit immutability and public balance-function denial: PASS'
else
  printf '%s\n' "no repair applied; this disposable catalog is ready for a reviewed repair rehearsal"
fi