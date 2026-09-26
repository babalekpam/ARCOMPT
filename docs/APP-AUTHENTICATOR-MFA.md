# ARCOMPT authenticator verification

## Purpose

ARCOMPT can perform authenticator verification independently of Clerk's paid MFA
feature. Clerk still authenticates the user's primary account. App-owned MFA is
an additional factor, not a replacement for Clerk authentication or a grant of
administrator authority.

## User flow

1. Sign in to ARCOMPT.
2. Open `/account/security`.
3. Add the displayed setup key to an authenticator application.
4. Enter a current code to finish enrollment.
5. Save the recovery codes securely. They are displayed only when generated.
6. When verification expires or a new sign-in session begins, enter a fresh
   authenticator code (or an unused recovery code) on the same page.

Never send setup keys, authenticator codes, or recovery codes to support or chat.
The account's verified email and Clerk user ID are not sufficient second factors.

## Administrator activation

Enrollment does **not** make a user a platform administrator. Activation remains
a separate, explicitly authorized and audited privileged operation using
`scripts/platform-admin.mts`. It must verify the exact Clerk identity, a verified
primary email, and an enrolled second factor. A customer-linked identity must not
be promoted into the independent platform-administrator identity.

Each privileged request must also have valid second-factor evidence for the
current sign-in session. A stored enrolled-factor flag alone does not authorize
requests. Do not add an email allowlist, frontend role flag, or MFA exemption to
work around failed verification.

## Deployment and operations

Migration `0030_app_mfa.sql` was applied transactionally to development and the
documented external ARCOMPT production database on 2026-09-25. Production checks
using the actual restricted application login confirmed both tables force RLS,
deny direct SELECT/UPDATE, and allow the scoped status function. The matching
application changes still require a user-triggered publish; no administrator
grant or user enrollment was performed during this implementation.

- Apply the new database migration to the development database and test with the
  restricted application role.
- ARCOMPT production uses external Neon, not the Replit-managed production
  database. Replit Publish does not migrate that external database.
- Review and apply the additive MFA migration to the explicitly documented
  ARCOMPT database only; preserve its migration ledger. Never apply it to
  NaviMed or substitute an owner connection for the runtime app login.
- Publish the matching API and web code together. Only then direct production
  users to the enrollment page.
- Preserve `PAYROLL_ENCRYPTION_KEY` (canonical base64 encoding of 32 random bytes)
  across restarts and publishes. MFA uses purpose-separated key derivation, not
  the payroll encryption context. No additional secret is required.
  Changing it without a planned migration can make enrolled factors unreadable.
- Keep MFA enrollment responses and recovery codes out of logs, analytics,
  caches, screenshots, and third-party QR-code services.
- Losing all factors requires an audited recovery process. Do not turn off the
  mandatory administrator MFA check to restore access.

Changing the administrative integration's credentials is separate from changing
Clerk's managed application keys. Do not overwrite managed sign-in keys to repair
an administrative connector.