# Replit-managed Clerk restoration review

## Scope and changes

The code restoration did not change keys, environment settings, Clerk users,
domains, databases or administrator grants. After separate user approval on
2026-09-26, Replit's managed setup successfully set `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY` and `VITE_CLERK_PUBLISHABLE_KEY`. After restarting the
development workflow, `/login` returned 200 and the branded form with Google
sign-in rendered without the previous signing-key mismatch. Full password/Google
login and production verification remain unproved; nothing was published.
Do not publish until reviewing the
environment checklist below. The site retains its existing styles, branded
Clerk screens, customer identities, server-side authorization, app-owned MFA and
dual administrator mode.

The application is Next.js with a private Hono API, not the skill's Express/Vite
example. The equivalent wiring uses Clerk's SDK host-derived publishable key on
both request middleware and provider/browser, and forwards the provisioned proxy
unconditionally in managed mode. An empty development proxy is intentional.
There is no invented production proxy fallback. Request-time server props prevent
a Next build's development values from overriding provisioned runtime values.
The SDK proxy route stays in the escaped `%5F%5Fclerk` directory. The browser uses
cookies; the trusted server-only BFF retains bearer verification to the private
API. External VPS configuration remains opt-in via `CLERK_HOSTING=external`.

## Review before changing anything

Do not paste keys in chat, logs or screenshots. Do not delete, rotate, rename or
hand-replace Replit-managed keys merely because they are hidden. Have Replit
restore the correct managed values if an earlier manual override replaced them.
Never copy a production key to development or a VPS key into this Replit app.

### Workspace: Secrets / development

| Name | Review |
| --- | --- |
| `CLERK_SECRET_KEY` | Must be the managed **development** instance's server key, not the previously copied production/external key. If manually overwritten, restore through Replit's managed configuration with Support guidance. |
| `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` | Keep the managed development public keys; test prefixes are expected. They must belong to the same instance as the secret. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Optional Next alias only. Audit/remove a stale manual override only after confirming the canonical managed keys exist; it must not select an external instance. |
| `AUTH_MODE` | `clerk`; never use `dev` as an authentication-error workaround. |
| `CLERK_HOSTING` | `managed`, or absent (managed default), for this Replit deployment. |
| `VITE_CLERK_PROXY_URL`, `CLERK_PROXY_URL`, `NEXT_PUBLIC_CLERK_PROXY_URL` | Leave managed provisioning in control. Empty in development is normal; do not add a proxy manually. Review stale user-added aliases. |
| `APP_URL`, `CLERK_AUTHORIZED_PARTIES` | Correct development origin(s), kept separate from production. Do not widen to arbitrary origins. |

### Published URL → Adjust settings → Production app secrets

Review independently of workspace values. Presence alone does not prove validity.

| Name | Review |
| --- | --- |
| `CLERK_SECRET_KEY` | Correct managed **production** key for the existing live tenant. Preserve that tenant and its users; do not generate a replacement tenant. |
| `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` | Managed production values, matching the production tenant. Next receives these at runtime; it must not retain a workspace override. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Same optional-alias review as above; no external/VPS value. |
| `CLERK_HOSTING`, `AUTH_MODE` | Managed (or unset hosting) and `clerk`. |
| `VITE_CLERK_PROXY_URL`, `CLERK_PROXY_URL`, `NEXT_PUBLIC_CLERK_PROXY_URL` | Confirm Replit supplies the production proxy. Next forwards this value; it no longer fabricates it. If missing, resolve managed provisioning before republishing. |
| `APP_URL`, `CLERK_AUTHORIZED_PARTIES` | Match the actual published HTTPS origins, including a secondary hostname only if intentionally supported. |

`ARCOMPT_CLERK_ADMIN_SECRET_KEY` is a separate optional CLI credential, not a
browser sign-in key. The Clerk connector has its own credential configuration:
correcting a runtime secret does **not** automatically repair its 401.
Do not change `PAYROLL_ENCRYPTION_KEY`, database connection secrets, R2, mail,
payment or other unrelated secrets. MFA enrollment and encrypted data depend on
preserving the existing encryption key.

## Google, domains and release verification

Google is configured in Replit's **Auth pane**, separately for Development and
Production. Enable/check it there. Keep `/login/[[...path]]` and
`/sign-up/[[...path]]`: they handle OAuth callback subpaths before the existing
`/api/session/landing` flow. Code tests cannot prove the external Google consent
round trip or that the provider is enabled.

Do **not** unlink/relink the custom domain or change DNS as part of this fix.
Managed Clerk uses the published same-origin proxy. Only consider a separate
domain repair if Replit diagnoses a specific domain-mapping failure.

After reviewing/restoring managed settings, restart preview, verify password and
Google login there, then republish. Test production password and Google login,
logout, callback routing, existing customer memberships, app MFA and (only after
an independently verified grant) administrator switching. Confirm no browser
request sends secret keys or obtains admin tokens via the generic proxy.
Development and production are separate user stores; successful development
login is not proof that production identity verification succeeds.

No super-admin grant is implied by package upgrades or restored login. Exact
verified identity, enrolled MFA and the audited provisioning step remain required.

## Dependency and automated checks

Registry latest versions checked during restoration: Next SDK 7.9.7, backend
3.20.1, themes 2.4.57 and transitive React SDK 6.17.2 were already current.
Localizations was upgraded from 4.18.0 to 4.20.0. Shared 4.36.0 was already a
transitive dependency and is now explicit for the supported key helper; the
themes package retains its own compatible shared 3.48.0 dependency. No forced
cross-major override was added.

Web tests: 26 files / 146 tests passed. Focused API Clerk authentication tests:
15 passed; MFA/admin-mode tests: 18 passed. API and web typechecks and Next
production build passed. The built route manifest includes the Clerk proxy and
both OAuth catch-all pages. No live browser password/Google login, production
identity verification or credential-restoration success is claimed by these tests.