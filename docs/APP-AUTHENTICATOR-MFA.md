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
primary email, and an enrolled second factor. The original customer `app_user`
must not be promoted or moved into the reserved organization.

Each privileged request must also have valid second-factor evidence for the
current sign-in session. A stored enrolled-factor flag alone does not authorize
requests. Do not add an email allowlist, frontend role flag, or MFA exemption to
work around failed verification.

### Same-login mode switching

The user's explicit dual-mode option keeps the ordinary customer identity and
memberships unchanged. Migration `0031_platform_admin_mode.sql` adds a binding
from the Clerk subject to a **separate** internal principal (an `app_user` in
the reserved organization with no `keycloak_sub`). This is not a customer role.
The default remains ordinary user mode. “Passer en super-admin” explicitly
activates the administrative session; “Revenir à mon compte” revokes it and
restores the previous customer-company selection.

This explicit-mode requirement applies to **dual-mode bindings**. Previously
provisioned standalone internal administrators deliberately retain their
legacy behavior: the verified internal identity plus mandatory MFA selects
administrator access automatically. They have no customer account to switch
back to; this compatibility path does not apply to dual-mode subjects.

Activation requires a confirmed ARCOMPT factor and a current session-bound
ARCOMPT MFA proof. The independent random mode token is hashed in PostgreSQL
and placed only in an HttpOnly, production-Secure, SameSite cookie by the BFF.
It expires no later than the MFA proof (maximum 15 minutes). Every privileged
request revalidates subject, Clerk session, proof, principal status, grant,
token expiry, and selected company. Proof replacement/recovery-code rotation
invalidates its modes through a foreign key. Activation/deactivation and
administrative access are recorded against the internal principal and Clerk
session. Customer suspension does not mutate this principal; admin revocation
is a separate audited operation.

The preserved HttpOnly customer-selection cookie also acts as a deny-only
mode tombstone. It outlives the short token cookie: after browser token expiry,
the BFF forwards that marker and the API returns `ADMIN_MODE_EXPIRED` rather
than silently using customer permissions with an administrative tenant.
Explicit exit clears it. Restoration requires the same Clerk subject **and
session**; a new login/session clears the old selection rather than reusing it.

Review and apply migration 0031 transactionally, with its ledger entry, to the
explicit external ARCOMPT database before publishing matching API/web code.
The managed Publish schema diff is not a substitute for its security functions,
privileges, or FORCE RLS. No business data moves or deletions are required.

Use a privileged operator connection to the verified ARCOMPT target only,
never the runtime login or NaviMed. Supply a valid production Clerk
administrative credential through `ARCOMPT_CLERK_ADMIN_SECRET_KEY` (preferred)
or an already correct `CLERK_SECRET_KEY`; do not overwrite managed keys.
The CLI refuses a subject/email mismatch, banned/locked identity, absent
confirmed app MFA, or absent existing customer identity.

```sh
# DATABASE_URL must already point to the explicitly verified ARCOMPT target.
# First preview; no writes without --apply.
corepack pnpm exec tsx scripts/platform-admin.mts --dual-mode \
  --action grant --sub VERIFIED_CLERK_SUB --email VERIFIED_PRIMARY_EMAIL \
  --reason "Explicitly authorized same-login admin switching" --operator OPERATOR
# After reviewing the preview, repeat with --apply --confirm-db arcompt.
# Revoke uses the same explicit mode flag and confirmation:
corepack pnpm exec tsx scripts/platform-admin.mts --dual-mode \
  --action revoke --sub VERIFIED_CLERK_SUB --reason "Authorized revocation" \
  --operator OPERATOR --apply --confirm-db arcompt
```

Revocation removes active mode sessions. A subsequent grant does not revive
old tokens. Revoking a dual-bound subject without `--dual-mode` fails explicitly
and asks for that flag; it never reports a misleading successful no-op.
Failure to verify the exact production Clerk subject is a blocker,
not permission to trust email alone. API endpoints live under
`/v1/security/admin-mode/{status,activate,deactivate}`; browser callers must use
`/api/session/admin-mode` (GET status, POST `{action}`), which never returns
the raw token. Generic proxy access to these token endpoints is blocked.
Mode transitions clear dynamic browser page/API caches and hard-navigate; the
service worker respects private/no-store responses. Administrator mode is
online-only (no privileged offline encryption material). Existing encrypted
customer drafts are not deleted. Close older tabs after publishing the new
service worker to discard the prior cache implementation.

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
- Preserve `PAYROLL_ENCRYPTION_KEY` (base64 encoding of 32 random bytes)
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