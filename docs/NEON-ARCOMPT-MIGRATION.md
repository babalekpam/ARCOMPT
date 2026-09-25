# ARCOMPT external Neon migration

## Scope and current status

The user approved a separate ARCOMPT database in the existing Neon project
alongside NaviMed. This replaces the earlier Replit-managed-database-only
constraint. It does not authorize replacing NaviMed data or deleting the
original ARCOMPT database.

**Provisioning is complete; data migration and application cutover are not.**
Do not publish against the new empty database.

### Explicit targets

| Item | Target |
| --- | --- |
| Neon project | `orange-hill-33196666` (console name `navimed-prod`) |
| Neon branch | `br-spring-cherry-avzq96be` (`production`) |
| ARCOMPT destination database | `arcompt` |
| NaviMed database — not a migration destination | `neondb` |
| ARCOMPT application login | `arcompt_app_login` |
| ARCOMPT queue login | `arcompt_queue_login` |
| NaviMed existing application login | `navimed_app_rls` |
| Schema owner, never an application login | `neondb_owner` |

The source is the existing **Replit-managed production database**, accessed
read-only. Its database name is also `neondb`, but it is not the NaviMed
database above. Never select a migration target using database name alone.

## Work performed

- Created the separate destination database and denied PUBLIC database access.
- Applied all 29 repository migrations in lexical order, each transactionally
  with its corresponding migration-ledger insertion.
- Created restricted app and queue logins with only their respective group
  memberships. Generated passwords without displaying or inspecting them.
- Preserved NaviMed's explicit CONNECT permission and revoked the default
  PUBLIC CONNECT permission on its database. No NaviMed tables or records
  were changed.
- Left the app configuration and the Replit production database unchanged.

## Checks completed

- All tenant tables have enabled, forced row-level security.
- Neither runtime login has superuser, BYPASSRLS, CREATEROLE, or CREATEDB.
- The app cannot claim cross-company jobs; the queue can, through its bounded
  functions, but cannot directly select job tables.
- The app cannot directly update accounting balances.
- No public application SECURITY DEFINER function has PUBLIC EXECUTE.
- NaviMed's login can connect to NaviMed but not ARCOMPT.
- Both ARCOMPT logins can connect to ARCOMPT but not NaviMed.
- The source inventory contains four companies and thirteen journal entries.
  The destination has zero companies; no business records have been copied.

These are catalog/privilege checks, not successful password-authenticated
connections or a full application-readiness test.

## Next gates — required before cutover

1. Obtain the two destination connection strings through Replit Secrets.
   Stage them as `ARCOMPT_NEON_APP_URL` and `ARCOMPT_NEON_QUEUE_URL`, not the
   active production URL keys. Select database `arcompt` and the exact runtime
   login for each string in Neon's Connect dialog. Never use the owner login.
2. Test real authenticated connections and the application's existing
   database-security and queue-security guards.
3. Take a consistent read-only source snapshot, including all business,
   identity, audit, document-reference, and encryption-related records.
   Keep sensitive exports out of Git and chat.
4. Import with an independently reviewed, atomic procedure that preserves
   IDs, decimals, timestamps, validated ledger history, audit hashes, and
   existing derived balances. Normal INSERT triggers can alter history and
   recompute balances; do not casually replay records or use seed data.
   Any destination-only temporary import accommodations must be restored
   before commit and before runtime access. Never weaken source protections.
5. Compare every table's counts and content fingerprints; check foreign keys,
   sequences, ledger balance/hash invariants, and external document/encryption
   dependencies. Reconcile source writes since snapshot before cutover.
6. Test tenant denial, immutable accounting/audit records, and queue isolation
   with the actual restricted logins.
7. Configure the application to use the verified external destination only
   after all checks pass. Keep privileged migration credentials out of the
   runtime. No schema changes belong in build or startup hooks.
8. Preserve the original Replit database for recovery. Publishing is a
   separate user action; this setup has not published the app.

Future NaviMed/ARCOMPT runtime roles must receive explicit CONNECT only to
their own database. Both databases share compute and privileged
administration; this is runtime-role isolation, not infrastructure isolation.