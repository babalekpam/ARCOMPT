---
name: Accounting AI provider routing
description: Why document and accounting AI requires explicit provider selection and no automatic fallback.
---

Route financial AI capabilities to providers explicitly, with one chosen default and optional per-capability overrides. Do not automatically switch to a different provider because a key is present, a request fails, or a model returns invalid output. Keep credentials on the server and treat live provider verification as separate from mocked tests.

Platform-owned AI credentials must be manageable from super-admin, not just
through hosting environment variables. Preserve environment credentials as the
explicit inherited configuration; removing a saved override must not pretend to
revoke a provider's key.

**Why:** The user specifically requested a place inside the app to add AI API
credentials, including all supporting routes. Settings must affect existing
accounting calls rather than merely saving an unused configuration.

**How to apply:** Keep keys encrypted and unreadable through HTTP responses,
require current admin/MFA authority for changes, and fail closed if decryption
fails. Preserve the encryption root when redeploying or restoring the database;
rotating it requires re-encrypting saved credentials, not simply changing the
environment value.

**Why:** Different models can produce different accounting results from the same document. A silent switch could change amounts or categorizations while appearing to be a normal successful run. The user selected Claude, OpenAI, and Gemini for existing accounting/document workflows, not for a new chat feature.

**How to apply:** When adding a new AI capability or model, require an explicit route, make missing credentials and provider errors visible, preserve validation and audit behavior, and do not turn development simulation into a production fallback.