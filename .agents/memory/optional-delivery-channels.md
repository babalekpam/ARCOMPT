---
name: Optional delivery channels
description: Safety principle for optional outbound communications during production configuration.
---

An optional communication channel without real credentials should be explicitly unavailable. Never make a webhook or queued send succeed with a mock sender, nor return success when a worker silently skips delivery. Partial credentials are a configuration error; development simulation must not leak into production.

**Why:** An accountant or customer may reasonably treat a successful reply, invitation, or reminder as delivered. Silently discarding the message can cause missed documents or deadlines while appearing operational.

**How to apply:** When adding or disabling a delivery integration, test HTTP and background-job paths together. A disabled channel should fail its outbound work visibly without blocking unrelated capabilities from starting.