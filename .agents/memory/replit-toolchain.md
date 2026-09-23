---
name: Replit package and test toolchain
description: Environment-specific constraints for deterministic installs and database-backed tests.
---

Use Corepack to invoke the repository-pinned pnpm version on Replit. Keep the project peer-install setting aligned with the lockfile, and run database-backed Vitest files serially with a longer hook timeout.

**Why:** Replit's pnpm launcher recursively tried to install the pinned package manager and timed out. The package firewall also rejected the old Vitest release; after upgrading to a Node 20-compatible release, parallel suites raced while creating a shared cluster-wide PostgreSQL role and cleanup exceeded the default hook timeout.

**How to apply:** Preserve the pinned package-manager version, use `corepack pnpm` in Replit commands, and do not re-enable full test-file parallelism unless the shared PostgreSQL login-role setup is made concurrency-safe.