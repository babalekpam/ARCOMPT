---
name: Zoho SMTP endpoint
description: Verified mail host choice for this project's sender account.
---

The Zoho account used by ARCOMPT authenticated with `smtp.zoho.com` on TLS port 465, and the user confirmed receipt of a real test message. A test against `smtppro.zoho.com` returned `554 5.7.8 Access Restricted` for the same account. Historical project guidance asserting that `smtppro` is always required for custom domains is not reliable for this account.

**Why:** Changing a working host based on generic provider advice would break invitations even though the configured endpoint has been tested end to end.

**How to apply:** Keep the verified host unless the provider/account configuration changes. After any change, test authentication and send one controlled message, then obtain recipient confirmation; do not infer inbox delivery solely from SMTP acceptance.