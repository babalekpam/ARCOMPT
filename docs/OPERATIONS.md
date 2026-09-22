# Exploitation

Ce guide décrit le déploiement et l'exploitation d'ARCOMPT conformément à `SECURITY.md` (§10 et §12). Les procédures qui ne sont pas encore outillées par le dépôt sont signalées comme telles ; la liste complète de ce qui n'est pas construit est en fin de `ARCHITECTURE.md`.

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
pnpm db:migrate                 # migrations 0001 → 0009, sous un compte distinct du rôle applicatif
SEED_FIRM=1 pnpm db:seed        # dossier PME + cabinet de démonstration (développement uniquement)
pnpm dev                        # web :3000, API :4000
pnpm worker                     # dans un second terminal
```

## Configuration de production : démarrage strict

Avec `NODE_ENV=production`, l'API refuse de démarrer tant que les secrets et les connecteurs ne sont pas réels : mode d'authentification, secrets de signature, clé de chiffrement de la paie, stockage objet, passerelle IA, antivirus, canal sortant WhatsApp, opérateur de paiement et connecteur de certification. La validation de démarrage **rassemble tous les problèmes et échoue avec la liste complète**, plutôt que d'échouer au premier : un déploiement se corrige en une passe.

Quelques simulations peuvent être acceptées sciemment en production au moyen de variables d'opt-out explicites, une par sujet ; elles sont volontairement repérables par une simple recherche dans la configuration. Les secrets de signature et l'opérateur de paiement n'en ont pas : aucune exception n'y est possible. Le détail des variables, de leur effet et des opt-out disponibles vit dans `.env.example`, qui reste la référence à jour.

## Rôles SQL

**Procédure cible ; la séparation n'est pas encore appliquée par le dépôt.** Aucun script ni migration ne la met en place : c'est une opération manuelle à faire sur chaque environnement.

- Les migrations s'exécutent avec un compte propriétaire (`arcompt` en local, compte de migration dédié en production).
- L'API et le worker devraient se connecter avec un rôle de connexion membre de `arcompt_app` : sans DDL, sans contournement de la Row-Level Security, sans écriture directe sur `account_balance`, `audit_log` ni `ai_call_log`. Ce rôle de connexion n'existe nulle part dans le dépôt : `0001_core.sql` crée `arcompt_app` en `NOLOGIN`, `docker-compose.yml` et `.env.example` connectent l'application avec le propriétaire du schéma, et seul le harnais de test crée `arcompt_app_login` (`packages/db/src/testing.ts`). Le créer et basculer `DATABASE_URL` dessus est à faire à la main ; tant que ce n'est pas fait, l'application tourne avec les droits du propriétaire (voir `docs/SECURITY.md` § 6).
- Aucun administrateur n'a de droit SQL direct sur les tables comptables en production ; les interventions passent par les procédures du portail (`admin_access_log`, break-glass). Là encore, rien dans le dépôt ne l'impose : c'est une règle d'exploitation.

## Secrets et clés

| Secret | Usage | Rotation |
| --- | --- | --- |
| `PAYROLL_ENCRYPTION_KEY` | Clé maître enveloppant les clés de données de paie par dossier | Annuelle : `PayrollService.rotateTenantKey()` re-chiffre chaque dossier |
| `KEYCLOAK_CLIENT_SECRET` | Client OIDC web | Annuelle |
| `PAYMENT_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET` | Signatures HMAC des webhooks | À chaque changement de fournisseur |
| `ANTHROPIC_API_KEY` | Passerelle IA | Trimestrielle |
| `R2_SECRET_ACCESS_KEY` | Object store | Annuelle |

Jamais dans le code, les images ni les journaux : `apps/api/src/security.ts` masque les motifs de secrets dans les journaux.

**Pas de gestionnaire de clés.** `packages/payroll/src/crypto.ts` définit l'interface `KeyProvider`, mais seule `EnvKeyProvider` est livrée : la clé maître est lue dans `PAYROLL_ENCRYPTION_KEY`. Il n'existe aucune implémentation KMS dans le dépôt. Injectez donc cette variable depuis le gestionnaire de secrets de l'hébergeur au démarrage du conteneur, et traitez sa rotation comme une opération manuelle : la chaîne « KMS → application » décrite dans `SECURITY.md` reste à construire.

## Sauvegardes et reprise

**Procédures manuelles.** Le dépôt ne contient ni script de sauvegarde, ni script de restauration, ni harnais d'exercice de reprise : tout ce qui suit s'exécute à la main, sur la console de l'hébergeur et en ligne de commande. À outiller.

- Objectifs : RPO ≤ 15 min, RTO ≤ 4 h ; pas de fenêtre de maintenance autour des échéances fiscales (voir `GET /v1/tax/calendar`).
- Neon : restauration à un instant donné (PITR) activée ; copie chiffrée dans une seconde région. À activer et vérifier depuis la console : rien dans le dépôt ne le configure.
- Chaque trimestre : restauration d'une sauvegarde sur un environnement isolé, puis `Ledger.verifyChain` sur chaque journal pour prouver l'intégrité. La vérification de la chaîne d'ancres (`verifyAnchorChain`) n'a pas d'objet tant qu'aucune ancre n'est produite (voir ci-dessous).
- Chaque année : exercice complet de reprise incluant la reconstruction de la clé maître de paie depuis le gestionnaire de secrets.

## Ancrage externe

**Conçu et testé, pas encore exécuté.** `packages/ledger/src/anchoring.ts` sait calculer la racine de Merkle quotidienne des écritures validées d'un dossier, chaîner les ancres et produire des preuves d'inclusion ; ces fonctions sont couvertes par des tests unitaires. Mais rien ne les appelle : aucune tâche de fond ne les déclenche, aucune migration ne crée de table d'ancre, et le seul publieur livré (`MemoryAnchorPublisher`) garde les ancres en mémoire du processus, donc les perd au redémarrage.

Mettre l'ancrage en service suppose trois chantiers, aucun commencé : une table d'ancres et sa migration, une tâche quotidienne qui appelle le calcul par dossier, et une implémentation d'`AnchorPublisher` vers un tiers (horodatage qualifié, registre public ou envoi signé au commissaire aux comptes) dont on conserve les références. Tant que ce n'est pas fait, ne présentez pas l'ancrage comme une garantie offerte aux clients.

## Surveillance

- Journaux structurés JSON sans montants nominatifs ni données de paie ; OpenTelemetry et Sentry sont pris en charge et s'activent en renseignant `OTEL_EXPORTER_OTLP_ENDPOINT` ou `SENTRY_DSN` (chargement dynamique au démarrage, `apps/api/src/telemetry.ts`). Non renseignées, l'API se contente des journaux structurés.
- Alertes de sécurité (`apps/api/src/telemetry.ts`) : rafale d'échecs d'authentification, rejets RLS (403), webhooks invalides ou rejoués, pics d'appels IA, divergences paiements / écritures, limitation de débit. Brancher un `AlertSink` vers l'astreinte.
- Contrôles de cohérence comptable (`GET /v1/anomalies`, contrôles des états) : certains signaux de fraude sont plus visibles dans les chiffres que dans les journaux techniques.

## Revue trimestrielle

Aucune de ces étapes n'est automatisée : la revue est une liste à dérouler à la main.

1. Tests de fuite entre dossiers (`pnpm test:tenancy`) sur la version déployée.
2. Revue des droits (`GET /v1/portal/org/entitlement-review`) et suspension des comptes inactifs. Les rôles se lisent et se modifient dans `company_member` depuis le portail, avec effet à la requête suivante.
3. Audit du journal des accès administrateur et des demandes break-glass.
4. Vérification des chaînes de hash (`Ledger.verifyChain`) ; la vérification des ancres attendra leur mise en service.
5. Test de restauration.

## Conformité pays

Avant lancement commercial dans un pays : déclaration ou autorisation auprès de l'autorité de protection des données (hébergement hors territoire), validation du pack pays par l'expert-comptable référent (`packages/country-packs/packs/<code>/README.md`), passage du pack en `PUBLISHED`.
