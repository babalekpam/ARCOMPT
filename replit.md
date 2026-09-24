# ARCOMPT project constraints

- The production VPS is shared with other applications. Before any ARCOMPT deployment or server change, inspect the existing services, ports, proxy configuration, databases, storage, and resource usage using read-only commands. Plan an isolated deployment that does not interrupt or alter other apps.
- Do not stop, restart, replace, reconfigure, or remove existing VPS apps or shared services, and do not change firewall or proxy rules, without the user's informed approval of the exact changes and their impact.
- Keep VPS credentials in Replit Secrets; never print them or put them in this file, logs, or chat.
- The user chose to prepare a Replit-hosted production route instead of deploying ARCOMPT on the shared VPS. Leave the VPS staging stopped and do not use or modify that VPS unless the user explicitly revisits this decision.
- Do not publish ARCOMPT or move its website DNS until restricted production database roles, RLS, scanner packaging, backups, and live sign-in/tenant isolation have been verified. See `docs/DEPLOYMENT-REPLIT-CURRENT.md`.