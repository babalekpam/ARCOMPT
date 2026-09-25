---
name: Publishing public port
description: Replit publishing supports one external port, even when development uses multiple services.
---

Expose only the website port when publishing ARCOMPT on a Replit VM; keep
backend and temporary test servers internal.

**Why:** Replit's Ports and troubleshooting documentation specifies a single
external port for VM and Autoscale publishing. Development can accumulate
additional port mappings that are incompatible with publishing. A successful
compilation alone does not verify server readiness.

**How to apply:** Review public mappings before publishing, preserve internal
web-to-API communication, and verify the website root responds successfully.
If runtime logs are unavailable, do not claim an incompatible mapping is the
only startup failure; confirm readiness on the next user-triggered publish.