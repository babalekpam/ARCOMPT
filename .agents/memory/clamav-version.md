---
name: ClamAV version on Replit
description: Production malware scanning depends on a supported engine, not just an installed package and signature files.
---

Do not assume the ClamAV package available from a Replit Nix channel is supported. Check the *installed binary* against ClamAV's official end-of-life matrix before wiring it into production. In September 2026 the project's stable channel supplied an end-of-life engine, and a test of Replit's `unstable` channel still supplied an older-than-current LTS patch despite upstream nixpkgs showing a newer release. The test was reverted. A stale Nix channel does **not** prove Replit-only scanning is impossible: the official vendor Linux distribution could run with its bundled shared libraries and download current signatures in this development environment.

**Why:** A scanner can be installed successfully yet fail to obtain current definitions or receive security fixes. Channel names do not guarantee an up-to-date package. Pointing the app at that daemon would create a false assurance of safe uploads. Conversely, a working development engine does not prove the publishing build carries it into the runtime image.

**How to apply:** Prefer a supported pinned release, verify it can update signatures and detect a test file, and keep document uploads fail-closed when the scanner cannot be verified. Verify the deployed build/run boundary separately before reopening a real-data site. Never change the app's whole Nix channel without testing the other runtime dependencies.