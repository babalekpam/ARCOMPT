---
name: Clerk on Next.js deployment
description: Why Replit-managed Clerk's Vite-oriented proxy guidance needs special handling in ARCOMPT's Next.js build and Replit configuration.
---

When adapting Replit-managed Clerk guidance to Next.js, ensure the same-origin Frontend API proxy is present in the **built route manifest** and selected by the **build-time public configuration**. A successful compile alone does not prove either point. Next treats underscore-prefixed route directories as private, so an unescaped Clerk path can silently disappear from the built routes.

**Why:** The managed Clerk reference assumes an Express/Vite app and describes a proxy variable injected for production. Next embeds public configuration during its build, which can happen before a production-only variable is available. A missing build-time proxy value can leave a working-looking login calling the Frontend API directly rather than the intended same-origin route.

**How to apply:** When changing auth, the publish build, or the Clerk route, check the Next build's route list and the generated public proxy setting together. Development intentionally uses a direct Frontend API connection. Treat the published interactive sign-in and cookie flow as unproved until tested separately.

A direct development curl to the proxy can return Clerk `host_invalid` even when the SDK route is present: the managed proxy is intended for a recognized published hostname, not the development instance. Do not treat this response alone as evidence of a code bug or bypass the SDK's Host handling. Verify the production hostname mapping and browser flow before declaring success.

When changing production Clerk tenants on the same domain, validate the tenant-specific mail/DKIM CNAME targets and the Frontend API HTTPS connection independently of key validation.

**Why:** A new live key pair can authenticate successfully while public DNS still contains the previous tenant's mail targets. The generic frontend/accounts CNAME targets alone do not prove that the new tenant's domain verification and certificate are ready.

**How to apply:** Compare the new tenant's domain configuration with authoritative DNS before public cutover. Do not alter unrelated website or mailbox records, and do not declare sign-in ready based on a successful Backend API request.

Replit rejects direct patches to `.replit`; build a full candidate TOML file and pass it to `verifyAndReplaceDotReplit` for schema validation. This is a workspace tooling constraint, not a reason to change the deployment workflow through ad hoc shell edits.