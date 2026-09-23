---
name: Clerk JWT header type
description: Why Clerk session token verification must not confuse HTTP Bearer transport with the JWT type.
---

Clerk's `verifyToken` option `headerType` checks the JWT header `typ`; it does not specify the HTTP Authorization scheme. Do not set it to `Bearer` for browser session tokens. Use the SDK default unless a specific JWT type is intentionally required, while still sending the token in an HTTP Bearer header.

**Why:** Setting `headerType` to `Bearer` rejected valid, verified Clerk sessions as `token-invalid`, which appeared to users as an expired session even after signing in again.

**How to apply:** For a 401 immediately after Clerk sign-in, distinguish JWT type checks from transport, authorized-party checks, signature checks, and the required session ID. Never log tokens or disable origin and session validation to make a login pass.