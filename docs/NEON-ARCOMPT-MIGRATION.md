# ARCOMPT external Neon migration

## Scope and current status

The user approved a separate ARCOMPT database in the existing Neon project
alongside NaviMed. This replaces the earlier Replit-managed-database-only
constraint. It does not authorize replacing NaviMed data or deleting the
original ARCOMPT database.

**Data migration and production connection configuration are complete.**
The app remains unpublished until the user publishes it. Preserve the original
Replit database; do not reset it or replace it with development data.

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
- Left the Replit production database unchanged.
- Configured the production launcher to source `select-production-database.sh`,
  which requires the external runtime secrets and sets both explicit and
  default clients to restricted connections. Development is unchanged.

## Checks completed

- All tenant tables have enabled, forced row-level security.
- Neither runtime login has superuser, BYPASSRLS, CREATEROLE, or CREATEDB.
- The app cannot claim cross-company jobs; the queue can, through its bounded
  functions, but cannot directly select job tables.
- The app cannot directly update accounting balances.
- No public application SECURITY DEFINER function has PUBLIC EXECUTE.
- NaviMed's login can connect to NaviMed but not ARCOMPT.
- Both ARCOMPT logins can connect to ARCOMPT but not NaviMed.
- Copied all 75 business tables, including four companies and thirteen journal
  entries. Every destination business-table count and content fingerprint
  matches the source. All six sequence states match.

The staged secrets have now passed real password-authenticated connections
using `scripts/check-neon-staging.mts`, including both existing production
security guards and the cross-application database privilege checks.
`scripts/check-neon-import.mts` also passed with the actual restricted logins:
contextless/cross-company reads denied, own-company reads allowed,
validated-entry changes denied, audit and balance writes denied, direct queue
table reads denied, and app cross-company job claims denied. Test writes were
transactional with forced rollback even on unexpected success.

Read-only preparation also confirmed:
- All 75 source business tables match the destination's column names, types,
  generated-column flags, and identity flags.
- The table-level foreign-key graph has a complete dependency ordering when
  self-references are excluded. Self-references still require explicit handling.
- Source records include 2,152 accounts, 13 entries, 38 journal lines, 29
  balance rows, and 23 audit rows. These now match the destination exactly.
- The user shut down ARCOMPT and deployment metadata confirmed it unpublished.
  Source fingerprints matched before export, after export, and after import.

## Transfer procedure and publishing handoff

The large single-request transfer was rejected by the connector, and the
destination was checked to confirm zero business rows. Bounded batches were
then uploaded to an owner-only temporary schema and fingerprinted before import.

The final import was atomic: lock and fingerprint the seed-only destination,
temporarily disable only user triggers, reconcile factory seeds, insert in
foreign-key dependency order, re-enable triggers, verify every business table,
check accounting invariants, and restore sequence state. Internal foreign-key
triggers remained active. No user trigger remains disabled. The temporary
transfer schema was removed after post-commit verification.

The destination retains its 29-entry schema-migration ledger, rather than
overwriting it with the source's 16 historical entries. The original source
retains that history unchanged.

Accounting checks returned zero unbalanced entries, cross-tenant lines,
invalid periods, broken audit links, invalid audit hashes, or mismatched
balance rows. Exact row fingerprints also cover ledger hashes and decimals.

The production launcher intentionally consumes `ARCOMPT_NEON_APP_URL` and
`ARCOMPT_NEON_QUEUE_URL`. Do not remove them because their names originated as
staging secrets. Missing values stop startup; there is no managed-owner fallback.

The production web build, shell configuration checks, and development preview
passed. Publishing remains a user action. The complete published runtime,
including scanner startup and production identity configuration, must still
be verified after publishing. Do not add schema mutations to build/startup.

Keep the original Replit database for recovery and decline any publishing
option to reset or replace its data. The existing Neon project reported a
six-hour recovery window at setup; recovery policy and a restore rehearsal
should be reviewed separately before relying on it for business continuity.

Future NaviMed/ARCOMPT runtime roles must receive explicit CONNECT only to
their own database. Both databases share compute and privileged
administration; this is runtime-role isolation, not infrastructure isolation.