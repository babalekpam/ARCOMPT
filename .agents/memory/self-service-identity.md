---
name: Self-service identity isolation
description: Why first-company signup and invitations need global identity checks despite tenant RLS.
---

A verified new login may create its first company, but eligibility must be checked across existing identities before creating a new organization, and invitation acceptance must serialize against the same identity decision. Do not infer a free identity merely from an empty tenant-scoped query.

**Why:** Forced row-level security hides users in other organizations. A normal application-role query can mistakenly report that a verified email has no account, including when another organization's matching account is suspended. Concurrent invitation acceptance can also create a conflicting identity unless it shares the eligibility boundary.

**How to apply:** For any future signup, invitation, or identity-linking path, keep ordinary company data under RLS but use a narrowly scoped global eligibility decision for collisions, then make the authorized creation and membership writes atomic.