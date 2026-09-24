# Pre-publish isolation check — 24 September 2026

**Decision: keep the public deployment shut down. Do not publish yet.** This
report records evidence from the development workspace and a read-only query of
Replit's production database replica. It is **not** a successful private
production deployment or a sign-off for real accounting data.

## Verified without publishing

- The configured next-publish build invokes `scripts/install-clamav.sh` and the
  configured runtime invokes `scripts/run-production.sh`. The installer
  downloaded its pinned, SHA-256-checked ClamAV 1.4.6 package, ran `freshclam`
  and produced `main.cvd`, `daily.cvd`, and `bytecode.cvd` in the build
  directory. The local binary reports ClamAV 1.4.6. **Carry-over of that build
  directory into an actual Replit Publish runtime has not been observed.**
- In an isolated temporary directory, the pinned `clamd` loaded copies of the
  installed signatures and answered the production readiness probe. The
  application's `ClamAvScanner` accepted a harmless PDF-shaped byte stream
  and rejected the canonical 68-byte EICAR test string with
  `Eicar-Test-Signature`. With clamd stopped, or the daily signatures removed or
  stale, the application scanner rejected scans rather than accepting them.
  A *PDF-prefixed EICAR string* was **not** detected by these signatures: that
  construction is not a substitute for a valid infected PDF fixture. The
  upload HTTP path itself remains untested in a production-like runtime.
- The Next production build completed and its route manifest includes
  `/api/__clerk/[[...path]]`. This proves the route is compiled, **not** that
  live Clerk authentication, session cookies, or proxying work.
- A development-only database backup with a disposable encryption key was
  encrypted and verified, then restored to a disposable drill database:
  7 checks passed and 1 had no applicable data. The drill database and
  temporary archive were removed. This does **not** validate a production
  backup key, schedule, off-site copy, or a restore of production data.
- Targeted scanner, storage-guard, and payroll-crypto/payroll tests passed
  (31 tests across 5 files); the workspace typecheck and Next production build
  passed. These payroll tests use test keys, not the production encryption key.
- The production database replica's read-only metadata query found 61
  `tenant_id` tables, all with RLS enabled and forced.

## Blockers and unproved checks

1. **Production database access:** The read-only production replica reports
   `neondb_owner` as the current role with `BYPASSRLS`; neither
   `arcompt_app` nor `arcompt_app_login` appeared in the role query. Forced
   table RLS alone does not prove the running application uses a restricted
   connection. Do not change the production schema or inject deployment-time
   SQL to repair this. Establish the restricted role and verify the Publish
   schema/security diff through the supported workflow before sign-off.
2. **Production-like runtime:** The project currently has no published
   deployment, including a private one. No isolated private Publish runtime
   has demonstrated that `.build/clamav-1.4.6` survives build packaging,
   starts with `scripts/run-production.sh`, and keeps the API unavailable
   when the scanner or signature update fails. Do not make it public for this
   test. The `.replit` setting says `deploymentTarget = "vm"` but its adjacent
   comments and the legacy deployment guide still say `gce`; confirm the
   Reserved VM target in the Publishing settings before attempting a private
   run. The local build does not validate that deployment target.
3. **Clerk:** The managed Clerk setup exists and the production route is in
   the Next build, but a production-tenant interactive sign-in, same-origin
   `/api/__clerk` proxy, cookies, MFA, and cross-tenant denials have not been
   tested. Development Clerk credentials cannot prove production sign-in.
4. **Object storage and payroll key:** The development test did not write to
   the production R2 bucket, and no separate disposable bucket was available
   for a production-credential put/get/delete round trip. Production secret
   presence does not prove either R2 operations or payroll-key decryptability.
   Do not use real documents or mutate production objects for a test.
5. **Preflight:** `corepack pnpm preflight` in this workspace returned exit 1:
   R2 and ClamAV runtime variables are absent in development, and the
   development database connects as a superuser with `BYPASSRLS`. It also
   explicitly skips real Clerk sessions, the live Clerk proxy, SMTP connection,
   mail authentication records, and the published site. Re-run it in the
   isolated, correctly configured production-like environment; resolve **all**
   blockers and independently verify skipped security checks. Do not work
   around them using `ALLOW_INSECURE_*`.
6. **Production backup/restore:** `BACKUP_ENCRYPTION_KEY` was not available
   for a production archive verification. The development drill above is not
   proof of a recoverable production backup. Use an authorized isolated copy
   and a disposable restore target, never a production restore target.

The public site stays closed until these items have actual evidence. In
particular, a successful local build and tests are not evidence that the
Publish build and runtime share the scanner files or that the live application
uses a safe database role.