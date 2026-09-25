# Automatic Publish redesign: security feasibility

## Decision

No security-equivalent, application-only redesign was identified under all of
the current constraints:

- Keep the existing Replit-managed production PostgreSQL database and records.
- Use only automatic Publish for production schema synchronization.
- Do not add an external database or VPS.
- Preserve database-enforced company isolation, accounting write restrictions,
  and the distinct API/queue privilege boundary.
- Do not use privileged-owner runtime connections or startup-time DDL.

This is an architecture assessment, not an executed production migration or
a new passing test report. No runtime security checks were removed.

## Why application checks are not equivalent

### Company isolation

`packages/db/src/client.ts` sets transaction-local tenant context. PostgreSQL
policies, rather than that setting alone, enforce access. The isolation tests
in `packages/db/src/db.test.ts` intentionally issue SQL without tenant filters,
attempt a forged tenant insert, and query without tenant context.

Adding tenant filters throughout application code would protect correctly
implemented requests, but would not preserve those guarantees for a missed
filter or arbitrary SQL executed with the owner credential. A BYPASSRLS role
ignores the policies even if their definitions exist.

### Accounting integrity

`packages/db/migrations/0001_core.sql` defines balance checks, validated-entry
and line immutability, numbering/hash checks, and balance-maintenance triggers.
Restricted-role grants additionally prohibit direct balance writes.
`packages/db/src/provision.test.ts` covers restricted-login tampering.

Moving these controls into route handlers would not provide equivalent
protection for writes outside those handlers. Table and column synchronization
alone does not establish the required functions, triggers, and grants.

### Background job separation

`apps/api/src/queue-database.ts` requires distinct app and queue principals.
The queue principal can execute a bounded set of cross-company functions but
cannot directly access the job tables. The app cannot execute those functions.
Two processes or two secrets pointing at the same owner login cannot reproduce
this capability separation.

## Consequence for implementation

The startup guards in `apps/api/src/database-readiness.ts` and
`scripts/run-production.sh` are detecting missing protections, not creating the
underlying incompatibility. Removing them would permit startup without fixing
the security model.

Replit Support has confirmed that automatic Publish does not fully propagate
the required roles/grants, functions/triggers, RLS predicates, and FORCE RLS.
Therefore there is no bounded code-only fix that satisfies the full constraint
set. Preserve the refusal to start rather than relabel weaker application-only
authorization as equivalent database security.

## What would change this decision

A supported, independently reviewed way to provision and maintain the required
production database security objects and restricted credentials would preserve
the current architecture. That path needs an authorized operator and is not
implemented by this assessment.

Accepting application-only enforcement would instead be a different security
contract and a substantial rewrite. It is not authorized by approval to assess
a redesign conditional on preserving the existing guarantees.

Do not execute the review-only repair draft on the basis of this document,
replay the already-applied Publish table creation statements, migrate existing
data, or place production DDL in build/startup.