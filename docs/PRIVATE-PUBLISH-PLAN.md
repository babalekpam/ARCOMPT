# Private Publish preparation (public site remains closed)

This is a staged test plan, **not** permission to publish publicly or a
production sign-off. The user approved preparing a private test and reviewing
production database security changes. Only the user can initiate Publish.

## What is ready

- The launcher refuses to start without a separate `APP_DATABASE_URL`.
  Replit's managed `DATABASE_URL` currently connects as `neondb_owner` with
  `BYPASSRLS`; it must **not** be used by the API or worker.
- Without Redis, the PostgreSQL queue requires its own `QUEUE_DATABASE_URL`.
  The app login may enqueue tenant jobs but cannot claim jobs across tenants;
  the separate queue login may call the claim/lease functions but cannot read
  the job tables directly. Both URLs must resolve to different restricted
  PostgreSQL roles.
- Before listening, both production API and worker check the actual connected
  role, forced tenant RLS, required policy expressions, secure functions and
  table privileges. Missing or permissive security objects stop startup.
- The scanner binary, signatures, clean/EICAR behavior and local production
  build were checked in development. Runtime packaging has not been tested in
  an actual Replit Publish environment.
- A forward migration hardens app-callable security-definer functions against
  temporary-table shadowing. The private Publish SQL review must use those
  latest definitions, not older function bodies from the initial migrations.

## Stop gate: the current Publish preview is insufficient

The read-only development-to-production preview contains 13 statements and
reports no structural data loss, but creates the two background-job tables
with unconditioned policies and without `FORCE ROW LEVEL SECURITY`, grants or
their security-definer functions. The production role check still finds only
`neondb_owner` with `BYPASSRLS`; the restricted app login is absent. The
production catalog is behind development (16 vs 26 recorded migrations).
Publishing now would leave the API down by design, **not** yield a safe test
site. Do not approve the current diff as a complete security migration.

A read-only catalog comparison found 12 missing function names: the two
bootstrap functions, four platform-admin functions, four queue claim/ack
functions, and the two review/retry functions. It also found the
`platform_admin_audit_immutable` trigger missing and three existing production
policies with no conditions. These are not repaired by the 13-statement
preview. The exact function bodies, policy expressions, grants and ownership
still need a reviewed comparison before any production SQL is approved.

The application requires custom PostgreSQL functions, triggers, policies,
grants and role provisioning from its ordered SQL migrations. The managed
Publish diff does not reproduce all of these; replaying migrations blindly
against existing production tables is unsafe. There is no production DDL in
the deployment build or startup script. The agent's production database
access is read-only. See `docs/PRIVATE-PUBLISH-SQL-GAPS.md` for the read-only
catalog gap inventory. No runnable production SQL is approved yet: ownership,
function privileges and the cross-tenant queue capability still need an
independent security review and disposable-copy rehearsal.

## Sequence before a private test can be approved

1. Inventory the current production catalog **read-only** against the
   development migration source: table ownership and forced RLS, policy
   expressions, function definitions/security-definer ownership, trigger
   attachments, role attributes, effective grants and recorded migrations.
   Review an exact, bounded reconciliation SQL plan against a disposable copy
   first. Do not run the unmodified migration files on production.
2. Agree on a Replit-supported way to apply the missing custom security
   objects and create a restricted login **without bypassing the user's
   Publish-flow constraint**. Replit's built-in Database SQL runner can
   perform manual SQL, but that is a separate operation and needs explicit
   approval before use. No production SQL has been executed here.
3. In Publishing, confirm **Reserved VM** and choose **private / invited
   collaborators only** before initiating any test. Do not connect a public
   domain or open public visibility. The user must start Publish in the UI;
   the agent cannot do it. Review the schema diff before confirming. Do not
   overwrite production data.
4. Configure production-only `APP_DATABASE_URL` and `QUEUE_DATABASE_URL`
   secrets for two separately provisioned restricted logins, never the owner
   URL. Once the security objects have been applied
   through an approved path, check actual connected-role privileges and
   `/ready` while private. Do not put credentials in code, logs or chat.
5. In the private runtime, confirm that the built ClamAV tree exists, signature
   update and clamd readiness succeed, and uploads fail closed if the daemon
   or definitions fail. Test a clean upload and a valid infected fixture (the
   canonical EICAR bytes prove the scanner, but a PDF-prefixed EICAR string
   is **not** a valid infected PDF). Verify production Clerk login, same-origin
   proxy, authorization/tenant denials, R2 put/get/delete using disposable
   objects, payroll-key round trip, and the whole preflight report.
6. Establish a separate production backup encryption key and test backup plus
   an authorized disposable restore target. Do **not** restore into production
   or claim a development-only drill protects production.

If any step fails, keep visibility private or unpublish. Do not make the site
public until the complete evidence is recorded in
`docs/PRE-PUBLISH-VERIFICATION.md`.