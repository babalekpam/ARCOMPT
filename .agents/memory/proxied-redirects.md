---
name: Redirects behind the preview proxy
description: Why authentication redirects should not use the internal Next.js request origin.
---

For same-origin server-side redirects behind Replit's proxy, use a relative `Location` rather than constructing an absolute URL from the internal request origin.

**Why:** The server can see an internal localhost origin while the browser uses a public domain. Building an absolute URL from that internal origin sends the browser to the wrong host.

**How to apply:** Prefer relative locations for same-origin navigation, especially in authentication and tenant-selection routes; reserve absolute redirects for intentional cross-origin destinations.