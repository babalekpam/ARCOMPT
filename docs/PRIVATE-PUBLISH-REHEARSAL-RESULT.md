# Database repair rehearsal — 24 September 2026

**Scope:** read-only checks of Replit's managed production database, and writes
only to a disposable local PostgreSQL 16 cluster. No production SQL, Publish,
or paid deployment was started. This is not authorization to publish or to run
the review-only SQL in production.

## Evidence gathered

- The current read-only Publish preview has 13 statements. It would create
  `background_job` and `background_job_review` with four unconditional policies,
  without forced RLS, missing job functions, and without restricted roles/grants.
- Before that preview is applied, the managed production catalog has 74
  non-job tables owned by `neondb_owner`; three existing unconditional policies;
  12 expected functions missing; the immutable-audit trigger absent; the
  reserved-organization constraints and `forbid_change()` present. It has 16
  migration records. The owner is not a superuser but has `BYPASSRLS` and
  `CREATEROLE`; app and queue roles are absent.
- All four exact read-only catalog fingerprints in
  `PRIVATE-PUBLISH-REPAIR-REVIEW.md` match the live **pre-preview** catalog.
  The nine existing application `SECURITY DEFINER` functions are owner-owned
  and have only owner/PUBLIC EXECUTE; the review candidate revokes PUBLIC
  execution from those and the new functions. Other existing owner grants,
  role memberships, schema/default ACLs, and optional `embedding` column were
  also inspected. No business rows were fetched for this comparison.
- The disposable rehearsal applied the captured preview and then the
  review-only repair candidate. It passed both actual application database
  readiness guards, wrong-role rejection, TCP/SCRAM authentication of two
  distinct restricted test logins, wrong-password denial, queue-table denial,
  queue-only cross-company claim, app cross-company job SELECT/UPDATE denial,
  no PUBLIC EXECUTE on any `SECURITY DEFINER` function, and validated-ledger
  and audit immutability. A deliberate catalog change was rejected by the
  repair preflight and left no repair roles committed.

To reproduce **locally only**, the script refuses inherited database
connection variables and creates/removes its own temporary PostgreSQL cluster:

```sh
env -i PATH="$PATH" HOME="$HOME" USER="$(id -un)" REHEARSE_REPAIR=1 bash scripts/rehearse-private-publish.sh
env -i PATH="$PATH" HOME="$HOME" USER="$(id -un)" REHEARSE_REPAIR=1 REHEARSE_REPAIR_DRIFT=1 bash scripts/rehearse-private-publish.sh
```

## Remaining gates

This result validates a *modeled* catalog repair, not the managed production
execution path. The candidate assumes the exact 13-statement preview has
already run and does not itself provision authenticated production logins,
configure their secrets, back up existing records, or reconcile the historical
migration ledger. The app must never replay those old migrations against a
manually repaired production catalog. The actual managed owner has not
executed the repair in a disposable managed instance.

Before any operator action: capture the then-current preview and live catalog
again, confirm production point-in-time recovery or a scheduled backup in
Replit's Database settings (project code checkpoints do not back up production),
settle a provider-supported
production SQL/operator procedure, review login creation and credential
rotation independently, and obtain explicit approval for the exact operation.
Replit's managed production database is read-only to Agent. Do **not** move
DDL into a build/start command, substitute the BYPASSRLS owner for either
runtime login, or treat a passing local rehearsal as permission to open the
site to real accounting data.