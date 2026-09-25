---
name: External Neon cohosting
description: Authorization and security boundaries for ARCOMPT alongside the existing NaviMed app.
---

The user approved moving ARCOMPT to a separate database inside the existing
external Neon project used by NaviMed. This supersedes the earlier requirement
to keep ARCOMPT exclusively on Replit-managed PostgreSQL.

**Why:** Automatic Publish could not provision the database-enforced security
objects ARCOMPT requires. An explicitly authorized external destination permits
controlled schema administration without weakening those guarantees.

**How to apply:** Preserve the original Replit production database; treat it as
a read-only migration source. Preserve NaviMed's records and runtime access.
Use separate databases and restricted runtime roles, never the shared owner
credential in either application. Stage and verify the migration before
switching runtime connections. Shared compute/administration is not physical
isolation. The operational migration document records targets and progress;
do not infer completion from authorization.

Neon MCP SQL uses prepared statements: send one statement per transaction
item, or a single reviewed DO block when executing a multi-statement migration.
SQL-created roles without a password cannot initially use Neon's password-reset
API. Initialize a random password entirely inside PostgreSQL first, then use
Neon's reset operation without displaying its returned credential.

**Why:** The MCP interface rejected multiple top-level commands in one query,
and the reset API returned HTTP 422 for a role with no initial password.
Neon API-created roles can have broader privileges than the app needs, so
creating minimal SQL roles avoids temporarily introducing privileged logins.

**How to apply:** Keep migration-ledger writes atomic with each migration;
verify actual role attributes and cross-database CONNECT permissions.
Use Replit Secrets to collect runtime URLs; never print generated passwords.