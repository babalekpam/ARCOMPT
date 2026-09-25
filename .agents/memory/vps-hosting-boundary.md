---
name: VPS hosting boundary
description: The user's identity and isolation choices for hosting ARCOMPT on a shared VPS.
---

The user approved a separately owned production Clerk tenant for a VPS-hosted ARCOMPT app after learning the current Replit-managed tenant cannot be used there. Keep Replit-managed Clerk for development; do not silently merge development identities into the new production tenant. The user declined the alternative of hosting the app on Replit with only its database on the VPS.

**Why:** Replit-managed Clerk production credentials are provisioned for Replit Publish, not an externally hosted VPS app. The user chose the separate production identity as the best way to deploy on a shared VPS without switching to a Replit-hosted hybrid.

**How to apply:** On VPS hosting work, use dedicated production credentials and keep other VPS apps unchanged. Production users/settings require separate verification; never infer that a development user already has a production account.

The newly selected VPS target is Windows Server, per the user. The existing app must remain untouched; do not assume earlier Linux/Plesk staging observations describe this target.

**Why:** The user clarified the operating system after a Linux-oriented connection assessment had been prepared. Earlier server inventory is not sufficient to identify the current target.

**How to apply:** Establish a supported Windows management connection and verify the OS with read-only checks first. Do not run Linux deployment scripts, enable remote-management services, change firewall rules, or restart the existing app without separately agreed scope.