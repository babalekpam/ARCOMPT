# Replit production route (Clerk)

> Preparation only. This document is not authorization to publish or handle real accounting data.
> `docs/DEPLOYMENT-REPLIT.md` is a legacy Keycloak/Auth.js guide; do not follow its identity instructions.

## Deployment boundary

- Use a **Reserved VM**, not Autoscale. The existing `.replit` build and `scripts/run-production.sh` start Next.js, the loopback API, and a supported ClamAV build. The PostgreSQL-backed queue is consumed by the API; no Redis process is required. Confirm the Reserved VM selection in Publishing before any private publish.
- Keep the existing six VPS apps and the stopped ARCOMPT staging on that VPS untouched. No Plesk, VPS database, firewall, or shared-service change is part of this route.
- The user chose **Replit Reserved VM without the VPS or a new Neon project**. The intended simple route would use Replit's built-in production PostgreSQL, but it is currently **blocked**: observed Publish previews omitted policy conditions, security functions, roles, grants, and forced RLS on new tables. The managed owner connection bypasses RLS. Do not approve that diff or put the owner connection into the API. A supported, verified way to reproduce the full security model must be established before publication; do not patch production from the app's build/start command.
- Use Replit-managed Clerk for Replit hosting (`CLERK_HOSTING=managed` or unset, `AUTH_MODE=clerk`). Replit's development and production tenants are distinct. Do not put the separate VPS Clerk keys into this production route. Keep Cloudflare R2's private Western Europe bucket for documents and the existing SMTP/AI integrations.

## Before requesting a private publish

1. Resolve the built-in production database security mismatch through a supported workflow **before** approving any Publish diff. Compare all tenant policies (including their conditions and forced RLS), security functions, ownership, group roles, and historical table/sequence/function grants against development. Test with actual restricted app and queue logins, not the managed owner. Do not run direct DDL against Replit's managed production database or add migrations to build/startup to make a failed Publish appear to work.
2. Only after this is verified, configure **distinct** restricted `APP_DATABASE_URL` and `QUEUE_DATABASE_URL` in production Secrets. Do not use the automatically supplied managed `DATABASE_URL` as either runtime URL. Never seed demonstration companies or users in production.
3. Provision `BACKUP_ENCRYPTION_KEY` through Secrets, keep a recoverable copy separately, and arrange encrypted off-site backups plus a restore drill. Do not write connection strings or encryption keys to this repository.
4. Verify production-only settings (`APP_URL` and `CLERK_AUTHORIZED_PARTIES` for the actual HTTPS deployment origin, `AUTH_MODE=clerk`, R2 credentials, AI, payroll encryption key, and SMTP). Determine the production URL from Publishing after a private publish; never infer it from a development URL. Run `pnpm preflight --mail` against the intended restricted database **without** `ALLOW_INSECURE_*` opt-outs.
5. Confirm the build emits `/api/__clerk/[[...path]]` and selects its same-origin Clerk proxy with the **production** publishable key. The build must carry the verified ClamAV executable and signatures into the VM; the runtime must refuse to start if it cannot update signatures. Verify Chromium actually renders a PDF in that runtime. Local tests and a successful build do not prove any of these published-runtime behaviors.

## Private validation and cutover gates

- Publish privately only after reviewing the database target and Publishing settings; publication may incur Reserved VM charges. Confirm startup, API `/ready`, anonymous `/api/proxy/ping` refusal, uploads with a real supported scanner, R2 write/read/delete, SMTP delivery, and a successful encrypted backup **and restore to an expressly disposable target**.
- Test interactive production Clerk sign-in, password recovery, OWNER/MFA, suspended and unassigned users, and access denial across two test tenants. No public OWNER is created merely to satisfy a health check.
- Only then request separate approval for the exact website-domain DNS change to Replit. Do not change the six VPS apps, mail records, or the already verified Clerk CNAMEs as a side effect. Re-run HTTPS, cookie, PDF, backup, and tenancy checks on the final domain before accepting real accounting records.

**Current preparation status:** `.replit` already selects `vm`, but the project is not published. The observed built-in production database diff is unsafe; production restricted database URLs and a backup encryption key are absent. The local scanner tests and Next build do not prove a published VM runtime. These remain blocking, not waived by this guide.