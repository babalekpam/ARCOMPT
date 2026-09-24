---
name: Development workflow cleanup
description: Prevents false port-conflict failures after a development workflow restart
---

A combined frontend/API workflow needs explicit cleanup of its child process groups on EXIT, TERM, and INT. If a restart reports port-in-use, check listeners and their process ancestry before restarting again; do not assume the server code failed.

**Why:** A previous launcher relied on `trap "kill 0" EXIT`. Restart marked the workflow failed while an older Next.js child was still serving on the frontend port; the new instance collided with it. A deliberate process-group cleanup fixed the port conflict.

**How to apply:** Keep the single configured development workflow, isolate the two service child groups, and terminate both groups in the cleanup trap. On failure, inspect process groups and logs, kill only the identified orphan group, then restart once and check both health endpoints.