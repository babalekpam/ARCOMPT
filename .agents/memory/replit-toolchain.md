---
name: Replit package and test toolchain
description: Environment-specific constraints for deterministic installs and database-backed tests.
---

Use Corepack to invoke the repository-pinned pnpm version for project commands. Replit's publishing pipeline runs its own `pnpm install` before the custom build command, so keep pnpm's automatic package-manager-version management disabled in project configuration; the Nix pnpm launcher can otherwise recurse while trying to install the pinned release. Keep the project peer-install setting aligned with the lockfile, and run database-backed Vitest files serially with a longer hook timeout.

**Why:** Replit's automatic publishing installer runs before the project's build command and uses the Nix pnpm binary. Its automatic version handoff recursively tried to install the pinned package manager until Node aborted, even though `corepack pnpm` worked locally. The package firewall also rejected the old Vitest release; after upgrading to a Node 20-compatible release, parallel suites raced while creating a shared cluster-wide PostgreSQL role and cleanup exceeded the default hook timeout.

**How to apply:** Preserve the pinned package-manager version; keep automatic version management disabled for the publishing install while using `corepack pnpm` for project commands. Do not re-enable full test-file parallelism unless the shared PostgreSQL login-role setup is made concurrency-safe.