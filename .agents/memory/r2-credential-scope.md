---
name: R2 credential scope checks
description: Security lesson from validating S3 credentials for a private accounting-document bucket.
---

Validate R2 credentials with a temporary upload/read/delete in the intended bucket, then use a read-only operation against a different bucket to check least-privilege scope. Do not treat successful object operations alone as proof that a token is restricted to one bucket.

**Why:** During setup, submitted credentials successfully wrote and read objects in the intended private bucket, but the test shell also listed the account's unused bucket. The account-level connector could not inspect token policies. Replit's documentation says running processes may retain earlier secret values until compute is restarted, so a test after replacement must establish that it used the new pair before attributing access to the replacement token.

**How to apply:** Keep production offline until the R2 token has Object Read & Write access to the intended bucket and cannot list other buckets. After rotating secrets, restart compute before interpreting a surprising cross-bucket result. Never print credential values. Do not revoke a working token before its restricted replacement has been tested.