# Keycloak (développement)

`docker compose --profile auth up -d keycloak` importe le realm `arcompt` depuis `realm-arcompt.json` :

- clients `arcompt-web` (code flow, secret de dev) et `arcompt-api` (bearer only) ;
- scope `arcompt-tenants` qui projette deux attributs utilisateur dans le jeton :
  - `organization_id` : identifiant de l'organisation (cabinet ou PME) ;
  - `tenants` : objet JSON `{ "<company uuid>": ["OWNER" | "ACCOUNTANT" | "CASHIER" | "AUDITOR" | "REVIEWER"] }`.
- deux utilisateurs de démonstration (`comptable` / `comptable`, `dirigeant` / `dirigeant`).

L'API (`AUTH_MODE=oidc`) vérifie le jeton via le JWKS de `KEYCLOAK_ISSUER` et n'accepte un `X-Tenant-Id` que s'il figure dans le claim `tenants`. En production, la MFA (TOTP) est rendue obligatoire pour les cabinets et les administrateurs en activant l'action requise `CONFIGURE_TOTP` par défaut sur le realm ou par groupe.

Les identifiants de dossier dans les attributs doivent correspondre aux `company.id` créés par le seed ou par le portail (`POST /v1/portal/org/companies`). Le portail met à jour les attributs via l'API d'administration Keycloak lorsque `KEYCLOAK_ADMIN_URL`, `KEYCLOAK_ADMIN_CLIENT_ID` et `KEYCLOAK_ADMIN_CLIENT_SECRET` sont renseignés ; sinon la mise à jour est manuelle.
