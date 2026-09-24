# ARCOMPT project constraints

- The production VPS is shared with other applications. Before any ARCOMPT deployment or server change, inspect the existing services, ports, proxy configuration, databases, storage, and resource usage using read-only commands. Plan an isolated deployment that does not interrupt or alter other apps.
- Do not stop, restart, replace, reconfigure, or remove existing VPS apps or shared services, and do not change firewall or proxy rules, without the user's informed approval of the exact changes and their impact.
- Keep VPS credentials in Replit Secrets; never print them or put them in this file, logs, or chat.