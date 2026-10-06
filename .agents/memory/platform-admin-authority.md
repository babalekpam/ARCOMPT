---
name: Platform administrator authority
description: Scope and security rationale for ARCOMPT's global administrator
---

The user chose a platform administrator that can manage the platform and read/edit every company's data. On 2026-09-25, they clarified that the same Clerk login must retain its ordinary customer account and explicitly switch into and out of super-admin mode. This supersedes the earlier separate-login requirement, not principal isolation or MFA.

**Why:** A platform identity attached to a customer organization could be suspended or otherwise affected by that customer's lifecycle. Cross-company authority is exceptionally broad, while the accounting system still needs each operation to obey its normal ledger invariants and tenant-scoped RLS.

**How to apply:** Preserve the original customer identity and memberships. Separately grant an internal principal, bind it to the login, and require explicit session-bound MFA-protected activation. Do not move the customer account or company into the reserved organization. Resolve the requested company and its organization server-side on each privileged request; execute the existing OWNER operations in that one company's RLS context and record the access. Do not globally disable RLS or permit arbitrary raw SQL editing. Provisioning and revocation are separate, privileged operations, and a working production account must not be inferred from successful development tests.

When the maintenance Clerk connector is unavailable but production login works,
use privileged, expiring exact-identity preapproval followed by runtime identity
verification and MFA, rather than replacing managed login secrets.

**Why:** Managed production credentials need not be exposed to maintenance tools.
The app can perform the provider check with its working live credentials, while
the operator's approval remains outside the runtime account's authority.

**How to apply:** Only the privileged operator approves the exact subject and
expected verified primary email. Approval alone is not a grant. Consumption must
atomically verify the live identity and fresh session-bound MFA, provision the
separate principal, record the audit, and activate mode. Do not claim access is
active while approval is pending or its supporting code is not yet published.

The user expects super-admin to be a platform-wide tenant overview with real
statistics, not merely an MFA settings page or company picker.

**Why:** Sending the user to Security without a clear onward action made the MFA
gate look like the complete administrator dashboard.

**How to apply:** Keep Security distinct from the platform overview; make
verification, explicit activation, and dashboard navigation clear on phones.
Include empty customer organizations in tenant discovery and exclude the
reserved internal organization from customer statistics.