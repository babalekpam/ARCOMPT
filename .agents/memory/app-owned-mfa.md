---
name: App-owned authenticator verification
description: Why MFA is implemented independently of Clerk's plan and how to preserve administrator safeguards.
---

Use app-owned authenticator verification rather than requiring a paid Clerk MFA
upgrade. Do not exempt the designated platform administrator from second-factor
verification.

**Why:** The user encountered a Pro restriction in Clerk and explicitly chose
app-owned verification over a lower-security administrator exemption.

**How to apply:** Keep Clerk primary authentication, explicit audited administrator
provisioning, customer-identity separation, and per-session second-factor checks.
Enrollment alone is not a privilege grant. Opted-in ordinary accounts must also
require verification; otherwise the account-security UI promises protection
that first-factor-only sessions can bypass.

When reusing an existing encryption master key for a new purpose, preserve the
existing decoder's byte semantics, not a stricter textual encoding requirement.

**Why:** Requiring canonical base64 in MFA rejected an existing 32-byte master
key accepted by payroll. Replacing the key to satisfy formatting would risk
making existing encrypted records unreadable.

**How to apply:** Keep the exact key bytes and purpose-separated derivation;
reject missing/wrong-length keys without a fallback. Test equivalent encodings
with synthetic keys, never log real key material.

Do not assume Clerk dashboard access includes permission to reveal or create
production secret keys in this Replit-managed tenant.

**Why:** The user's production API-keys screenshot explicitly showed “You need
additional permissions to view secret keys.” Repeated copy/rotation instructions
cannot resolve that permission boundary.

**How to apply:** Stop asking for dashboard key copying or rotation when that
restriction appears. Use a supported managed administrative path or establish
the needed permission first; never replace working app login keys to repair
an administrative connector.