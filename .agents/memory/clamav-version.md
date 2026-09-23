---
name: ClamAV version on Replit
description: Production malware scanning depends on a supported engine, not just an installed package and signature files.
---

Do not assume the ClamAV package available from an existing Replit Nix channel is supported. Check the installed engine against ClamAV's official end-of-life matrix before wiring it into production; the channel investigated in September 2026 supplied an engine whose patch support and signature download access had ended.

**Why:** A scanner can be installed successfully yet fail to obtain current definitions or receive security fixes. Pointing the app at that daemon would create a false assurance of safe uploads.

**How to apply:** Prefer a supported pinned release, verify it can update signatures and detect a test file, and keep document uploads fail-closed when the scanner cannot be verified. Never change the app's whole Nix channel without testing the other runtime dependencies.