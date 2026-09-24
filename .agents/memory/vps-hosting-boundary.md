---
name: VPS hosting boundary
description: The user's declined hosting alternatives when Replit-managed Clerk and VPS hosting conflict.
---

Do not treat either an independently managed Clerk tenant for a VPS-hosted app or a Replit-hosted app with only PostgreSQL on the VPS as an approved deployment path. The user chose to retain Replit-managed Clerk and explicitly stopped the database-only VPS alternative. These choices may be revisited only if the user gives a new direction.

**Why:** Replit-managed Clerk production credentials are provisioned for Replit Publish, not an externally hosted VPS app; the user declined changing the identity tenant and then declined the proposed hosting split.

**How to apply:** On future hosting requests, explain the incompatibility before making server or identity changes. Do not infer consent to either previously declined alternative from general authorization to deploy.