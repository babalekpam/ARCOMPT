---
name: Managed Publish schema round trips
description: Limits observed when Replit's managed Publish flow introspects this project's PostgreSQL schema.
---

Inspect the generated development-to-production SQL whenever publishing custom database constraints or security objects. A bare boolean check can be emitted as invalid nested `CHECK (CHECK (...))`; an equivalent explicit boolean expression such as `IS TRUE` round-trips correctly.

**Why:** The development constraint was valid, but publish-time introspection generated invalid SQL. Separately, the observed diff omitted conditions from row-level-security policies and did not include custom database functions, even though those existed in development. A syntactically valid diff alone therefore does not prove equivalent access control or runtime behavior. Copying missing SECURITY DEFINER functions is not a safe repair by itself: function ownership and cross-tenant EXECUTE grants must match the intended privilege boundary, especially when the managed owner has BYPASSRLS.

**How to apply:** Compare generated policy definitions, function availability, ownership, privileges, and triggers with development before authorizing a live publish. Review any cross-tenant function capability on a disposable copy before preparing manual production SQL. Never compensate by injecting production DDL into build or startup steps.