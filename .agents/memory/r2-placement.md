---
name: R2 placement for African documents
description: Why the storage location hint matters for this project's accounting documents.
---

Use a Western Europe location hint for the project's African accounting documents when creating R2 buckets, unless the user chooses a different residency requirement. A hint is best-effort and is not an EU jurisdictional guarantee.

**Why:** The user chose Automatic for Africa, but creation through the Cloudflare integration placed the bucket in Eastern North America because Automatic follows the request origin. After learning this, the user chose a new bucket with a Western Europe hint. Cloudflare does not offer an Africa-specific R2 location option.

**How to apply:** Check the actual returned bucket location and private-access settings before using a new bucket in production. Do not assume Automatic places data near African users or that a location hint meets legal residency requirements.