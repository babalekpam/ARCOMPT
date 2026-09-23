---
name: Managed Publish schema round trips
description: Limits observed when Replit's managed Publish flow introspects this project's PostgreSQL schema.
---

Inspect the generated development-to-production SQL whenever publishing custom database constraints or security objects. A bare boolean check can be emitted as invalid nested `CHECK (CHECK (...))`; an equivalent explicit boolean expression such as `IS TRUE` round-trips correctly.

**Why:** The development constraint was valid, but publish-time introspection generated invalid SQL. Separately, the observed diff omitted conditions from row-level-security policies and did not include custom database functions, even though those existed in development. A syntactically valid diff alone therefore does not prove equivalent access control or runtime behavior.

**How to apply:** Compare generated policy definitions, function availability, privileges, and triggers with development before authorizing a live publish. Make source-of-truth and development changes only; do not compensate by injecting production DDL into build or startup steps.