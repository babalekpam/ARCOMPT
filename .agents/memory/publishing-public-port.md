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

Development listeners on all interfaces can cause Replit to automatically
reintroduce public port mappings. Keep internal services on loopback, not just
absent from the port list.

**Why:** Restarting development and running a temporary production-mode web
test regenerated external mappings after manual cleanup.

**How to apply:** Stop temporary test servers, keep the browser's same-origin
proxy as the entry point, and recheck the public mappings after verification.

Start the real public website independently of scanner initialization, but
keep the API unavailable until security readiness passes. Never replace this
with a fake successful health endpoint or permit unscanned uploads.

**Why:** The publishing startup deadline can expire while the launcher waits
on antivirus setup, before any website listener exists.
The user confirmed that separating website startup allowed publishing. This
confirms website availability, not full API readiness or sufficient capacity
for the website, API, and scanner together.

**How to apply:** Supervise the early website with the same failure cleanup
as the scanner and API. Verify both early HTTP availability and shutdown on
security failure; stage logs should distinguish web and dependency startup.