# Production SQL security gaps — read-only inventory

**Not an executable repair. Do not publish publicly or paste migration SQL
into the production database.** This inventory was compiled from read-only
development and production catalog queries and the current Publish schema
preview. No production SQL was executed.

## What the current Publish preview would miss

- The 13-statement preview creates the background-job tables but omits their
  forced RLS, tenant and owner policy expressions, function definitions and
  grants. The preview is not a faithful application of the development SQL.
- The production catalog currently reports 16 migration records, versus 26
  in development. These records are not proof that Publish installed the
  functions or policies from those migrations.
- The restricted `arcompt_app` group and `arcompt_app_login` are absent.
  Production's available `neondb_owner` login has `BYPASSRLS`.
- Development now defines a separate `arcompt_queue` capability and hardens
  security-definer function bodies against temporary-object shadowing. Neither
  change is established in production merely by changing local source files;
  the private Publish preview and any reviewed SQL repair must be rechecked.
- Twelve function names are missing in production:
  `auth_bootstrap_lookup`, `auth_bootstrap_replay`,
  `platform_admin_identity`, `platform_admin_company`,
  `platform_admin_companies`, `platform_admin_record_access`,
  `background_job_claim`, `background_job_renew`,
  `background_job_finish`, `background_job_expire_reminders`,
  `background_job_retry_internal`, and
  `background_job_review_reminder`. The
  `platform_admin_audit_immutable` trigger is missing.
- Existing production policies
  `onboarding_bootstrap.onboarding_bootstrap_access`,
  `platform_admin.platform_admin_internal`, and
  `platform_admin_audit.platform_admin_audit_internal` have no conditions.
  Their development definitions are conditioned.

## Why a copy-and-paste SQL bundle is not safe yet

The security-definer functions and RLS policies depend on **who owns each
table and function**, which roles can execute the functions, and whether the
reserved platform-admin organization invariant exists. Replaying migration
fragments onto partially published tables can create functions owned by a
`BYPASSRLS` role or expose cross-company job payloads through broad grants.
The code now splits the app and queue roles, but the corresponding production
roles/grants and the latest hardened definitions are not yet present.

The exact current **13-statement, read-only Publish preview** is saved as a
non-runnable reference in `docs/PRIVATE-PUBLISH-PREVIEW.md`. It is a snapshot
of what Publish proposes to apply, **not** a repair script. If a private
Publish ever applies that diff, do not replay the preview afterward: the
background-job tables will already exist. Recheck the diff immediately before
any Publish, because the saved preview may become stale.

Before drafting any production SQL, verify the exact production ownership,
policies, grants, function bodies, trigger attachments, migration invariants,
and protected role membership. Test a *specific, idempotent* repair against a
disposable copy, including read-only checks for tenant isolation and worker
privileges. Do not run the migration files wholesale. The app startup guard
will reject the currently observed privileged role and incomplete policies;
that safe refusal is **not** proof a private deployment is ready.

A preliminary transaction draft was withdrawn after independent review: it
covered only 12 of the 20 functions checked at startup and omitted historical
table/sequence grants. Its rehearsal helper could not guarantee a disposable
target. The replacement in `PRIVATE-PUBLISH-REPAIR-REVIEW.md` is **for operator
review only, not production execution**. It includes the 20 guarded functions,
the qualified ledger-balance trigger, all 278 observed application grants,
preflight catalog checks and a local-only rehearsal. The local rehearsal
passes the restricted app startup guard, tenant-isolation checks, queue
separation and ledger/audit immutability tests. Its synthetic PostgreSQL
cluster is not a production backup or proof of live runtime behavior.

Read-only catalog comparisons found that the 74 existing tables' constraints,
indexes, unaffected triggers, policies, RLS flags and PUBLIC table grants
match development, apart from the three known policy/FORCE gaps and missing
audit trigger. The 817 comparable column definitions/defaults/PUBLIC column
grants, six sequence definitions/PUBLIC grants, and 15 unchanged non-extension
application function bodies also match. The optional vector embedding is
excluded from the local fixture comparison because pgvector is unavailable
there. The reviewed transaction checks these baselines again before changing
anything and aborts on drift.

Production remains blocked: this candidate neither provisions restricted
logins nor reconciles migration history. Before any private Publish or manual
SQL, an authorized operator must establish the execution, backup/rollback,
restricted-login and migration-history procedure, recapture the Publish
preview and production catalog, and approve the exact SQL. Keep the public
site closed through post-Publish runtime smoke tests.

The latest read-only comparison found 76 development tables and 74 production
tables; the two missing tables are the background-job tables. The other 74
tables have matching column names, types, and nullability. That limited match
does **not** establish matching constraints, roles, functions, policies,
ownership, grants, or runtime behavior.

Replit's agent production database connection is read-only. Any later manual
SQL step in Replit's Database tool requires an independently reviewed
statement set and explicit operator action. The current authorization was
to **prepare SQL for review**, not to execute it.