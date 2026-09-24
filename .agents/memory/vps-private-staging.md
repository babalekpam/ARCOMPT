---
name: VPS private staging
description: Shared VPS isolation and trustworthy private smoke testing.
---

Keep ARCOMPT's database separate from the VPS's existing PostgreSQL service. Its dedicated PostgreSQL instance is loopback-only and can be stopped while deployment is paused; never assume the existing database, proxy, or a convenient web port belongs to ARCOMPT.

**Why:** The VPS hosts six other apps. During a private smoke test, an apparently free web port was actually owned by another app; HTTP 404 responses came from that app after ARCOMPT's web process failed to bind. The user reiterated their concern about the other apps and deployment was paused.

**How to apply:** Inspect live listeners and process ownership before testing. Verify the ARCOMPT process started and owns the chosen port before attributing a response to it. Do not change Plesk routing, shared services, or add the broad Chromium dependency transaction without a clear impact discussion and user approval.