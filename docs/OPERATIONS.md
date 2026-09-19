# Exploitation

Ce guide décrit le déploiement et l'exploitation d'ARCOMPT conformément à `SECURITY.md` (§10 et §12).

## Composants

| Processus | Commande | Rôle |
| --- | --- | --- |
| API | `pnpm --filter @arcompt/api start` (image `infra/docker/api.Dockerfile`) | Hono sur `API_PORT` (4000) : modules métier, webhooks publics `/whatsapp`, `/webhooks` |
| Worker | `pnpm worker` | Tâches de fond (extraction IA, réponses WhatsApp, relances) ; BullMQ si `REDIS_URL`, sinon en processus |
| Web | `pnpm --filter @arcompt/web start` (image `infra/docker/web.Dockerfile`) | Next.js PWA sur 3000, proxy `/api/proxy` vers l'API |
| PostgreSQL 16 | Neon en production, `docker compose up postgres` en local | Une base par environnement, jamais partagée |
| Redis 7 | facultatif | File de tâches |
| Keycloak | `docker compose --profile auth up keycloak` | Realm `infra/keycloak/realm-arcompt.json` |
| Stockage | R2 (`R2_*`) ou disque local (`STORAGE_DIR`) | Pièces justificatives et exports |

## Mise en route

```bash
cp .env.example .env            # renseigner les secrets depuis le gestionnaire de secrets
docker compose up -d            # PostgreSQL + Redis
pnpm install
pnpm db:migrate                 # migrations 0001 → 0008, sous un compte distinct du rôle applicatif
SEED_FIRM=1 pnpm db:seed        # dossier PME + cabinet de démonstration (développement uniquement)
pnpm dev                        # web :3000, API :4000
pnpm worker                     # dans un second terminal
```

En production : `AUTH_MODE=oidc`, `NODE_ENV=production` (le mode dev est refusé), `PAYROLL_ENCRYPTION_KEY` injectée par le KMS, `WHATSAPP_APP_SECRET` et `PAYMENT_WEBHOOK_SECRET` obligatoires, `CERTIFICATION_CONNECTOR` réel pour les pays où la facture normalisée est obligatoire (CI, BJ, BF, NE).

## Rôles SQL

- Les migrations s'exécutent avec un compte propriétaire (`arcompt` en local, compte de migration dédié en production).
- L'API et le worker se connectent avec un rôle membre de `arcompt_app` : sans DDL, sans contournement de la Row-Level Security, sans écriture directe sur `account_balance`, `audit_log` ni `ai_call_log`.
- Aucun administrateur n'a de droit SQL direct sur les tables comptables en production ; les interventions passent par les procédures du portail (`admin_access_log`, break-glass).

## Secrets et clés

| Secret | Usage | Rotation |
| --- | --- | --- |
| `PAYROLL_ENCRYPTION_KEY` | Clé maître enveloppant les clés de données de paie par dossier | Annuelle : `PayrollService.rotateTenantKey()` re-chiffre chaque dossier |
| `KEYCLOAK_CLIENT_SECRET` | Client OIDC web | Annuelle |
| `PAYMENT_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET` | Signatures HMAC des webhooks | À chaque changement de fournisseur |
| `ANTHROPIC_API_KEY` | Passerelle IA | Trimestrielle |
| `R2_SECRET_ACCESS_KEY` | Object store | Annuelle |

Jamais dans le code, les images ni les journaux : `apps/api/src/security.ts` masque les motifs de secrets dans les journaux.

## Sauvegardes et reprise

- Objectifs : RPO ≤ 15 min, RTO ≤ 4 h ; pas de fenêtre de maintenance autour des échéances fiscales (voir `GET /v1/tax/calendar`).
- Neon : restauration à un instant donné (PITR) activée ; copie chiffrée dans une seconde région.
- Chaque trimestre : restauration d'une sauvegarde sur un environnement isolé, puis `Ledger.verifyChain` sur chaque journal et `verifyAnchorChain` sur les ancres pour prouver l'intégrité.
- Chaque année : exercice complet de reprise incluant la reconstruction des clés depuis le KMS.

## Ancrage externe

`packages/ledger/src/anchoring.ts` calcule chaque jour la racine de Merkle des écritures validées par dossier. Publier l'ancre via un `AnchorPublisher` (horodatage qualifié, registre public ou envoi signé au commissaire aux comptes) et conserver les références : l'immutabilité devient prouvable.

## Surveillance

- Journaux structurés JSON sans montants nominatifs ni données de paie ; `OTEL_EXPORTER_OTLP_ENDPOINT` et `SENTRY_DSN` activent OpenTelemetry et Sentry.
- Alertes de sécurité (`apps/api/src/telemetry.ts`) : rafale d'échecs d'authentification, rejets RLS (403), webhooks invalides ou rejoués, pics d'appels IA, divergences paiements / écritures, limitation de débit. Brancher un `AlertSink` vers l'astreinte.
- Contrôles de cohérence comptable (`GET /v1/anomalies`, contrôles des états) : certains signaux de fraude sont plus visibles dans les chiffres que dans les journaux techniques.

## Revue trimestrielle

1. Tests de fuite entre dossiers (`pnpm test:tenancy`) sur la version déployée.
2. Revue des droits (`GET /v1/portal/org/entitlement-review`) et suspension des comptes inactifs.
3. Audit du journal des accès administrateur et des demandes break-glass.
4. Vérification des chaînes de hash et des ancres.
5. Test de restauration.

## Conformité pays

Avant lancement commercial dans un pays : déclaration ou autorisation auprès de l'autorité de protection des données (hébergement hors territoire), validation du pack pays par l'expert-comptable référent (`packages/country-packs/packs/<code>/README.md`), passage du pack en `PUBLISHED`.
