---
name: Platform administrator authority
description: Scope and security rationale for ARCOMPT's global administrator
---

The user chose a platform administrator that can manage the platform and read/edit every company's data. On 2026-09-25, they clarified that the same Clerk login must retain its ordinary customer account and explicitly switch into and out of super-admin mode. This supersedes the earlier separate-login requirement, not principal isolation or MFA.

**Why:** A platform identity attached to a customer organization could be suspended or otherwise affected by that customer's lifecycle. Cross-company authority is exceptionally broad, while the accounting system still needs each operation to obey its normal ledger invariants and tenant-scoped RLS.

**How to apply:** Preserve the original customer identity and memberships. Separately grant an internal principal, bind it to the login, and require explicit session-bound MFA-protected activation. Do not move the customer account or company into the reserved organization. Resolve the requested company and its organization server-side on each privileged request; execute the existing OWNER operations in that one company's RLS context and record the access. Do not globally disable RLS or permit arbitrary raw SQL editing. Provisioning and revocation are separate, privileged operations, and a working production account must not be inferred from successful development tests.