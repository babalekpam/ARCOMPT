---
name: Protected Replit config edits
description: Workspace policy for safely changing deployment commands in .replit.
---

Direct patching of .replit may be rejected. Prepare the full TOML in a temporary workspace file and use the environment's schema-validated replacement callback; remove the temporary file afterward.

**Why:** Direct patch attempts were refused, and one multi-file patch still applied its unrelated deletions, briefly leaving a run command pointing to a missing script. Validation also caught an incorrectly escaped TOML command.

**How to apply:** Serialize .replit edits and other dependent file changes. Validate/replace the config before removing a referenced script, then inspect the diff and workflow status.