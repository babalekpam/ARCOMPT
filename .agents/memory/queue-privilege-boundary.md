---
name: Queue privilege boundary
description: Why the PostgreSQL queue needs a separately verified restricted login
---

Treat cross-tenant queue claiming as a separate database capability from ordinary HTTP tenant data access. When both operations run in one process, two connection pools can still keep SQL capabilities separate; never assume process separation is required or that a shared database login is harmless.

**Why:** A schema-owner connection masks missing grants and accepts table probes that correctly fail for a queue login with no direct table access. A grant-only startup check can also pass while a misowned or non-SECURITY-DEFINER function fails every actual poll. Review found these different failure modes only after testing a real restricted queue login.

**How to apply:** In disposable integration tests, connect as the actual app and queue logins, exercise enqueue and the claim/lease lifecycle, and inspect effective role attributes, schema usage, function ownership/search path, and absence of direct job-table access. Do not use the owner pool as a stand-in for the queue connection. Keep production runtime fail-closed until both logins pass.