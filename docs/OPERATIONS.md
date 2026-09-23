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
pnpm db:migrate                 # migrations 0001 → 0010, sous le compte propriétaire du schéma

# Une fois par base : créer le rôle de connexion applicatif, puis basculer
# DATABASE_URL de l'API et du worker dessus (voir « Rôles SQL »).
APP_DB_PASSWORD='<mot de passe fort>' pnpm exec tsx scripts/provision-app-role.mts

SEED_FIRM=1 pnpm db:seed        # dossier PME + cabinet de démonstration (développement uniquement)
pnpm dev                        # web :3000, API :4000
pnpm worker                     # dans un second terminal
```

Ordre imposé : `db:migrate` crée le rôle de groupe `arcompt_app` et pose ses
droits ; `provision-app-role` ne fait que lui rattacher un rôle de connexion.
Lancé avant les migrations, il refuse avec un message explicite.

## Configuration de production : démarrage strict

Avec `NODE_ENV=production`, l'API refuse de démarrer tant que les secrets et les connecteurs ne sont pas réels : mode d'authentification, secrets de signature, clé de chiffrement de la paie, stockage objet, passerelle IA, antivirus, canal sortant WhatsApp, opérateur de paiement et connecteur de certification. La validation de démarrage **rassemble tous les problèmes et échoue avec la liste complète**, plutôt que d'échouer au premier : un déploiement se corrige en une passe.

Quelques simulations peuvent être acceptées sciemment en production au moyen de variables d'opt-out explicites, une par sujet ; elles sont volontairement repérables par une simple recherche dans la configuration. Les secrets de signature et l'opérateur de paiement n'en ont pas : aucune exception n'y est possible. Le détail des variables, de leur effet et des opt-out disponibles vit dans `.env.example`, qui reste la référence à jour.

## Sondes et arrêt en douceur

| Point | Ce qu'il fait | Usage |
| --- | --- | --- |
| `GET /health` | Répond `{ok:true}` sans toucher à aucune dépendance | Vivacité : un échec veut dire « redémarrez ce conteneur » |
| `GET /ready` (alias `GET /health/ready`) | Aller-retour `SELECT 1` vers PostgreSQL, délai borné à 2 s ; `200` si tout est debout, `503` sinon | Aptitude : c'est ce point que l'équilibreur de charge interroge |

Le corps de `/ready` ne donne que l'état par dépendance
(`{"ready":false,"dependencies":[{"name":"database","state":"down"}]}`) : ni
message d'erreur, ni hôte, ni identifiant. Le détail part dans les journaux
(`ready.dependency_down`). Ne branchez **pas** la sonde de vivacité sur `/ready` :
une base momentanément injoignable ferait redémarrer en boucle des processus
parfaitement sains.

À l'arrêt (SIGTERM, SIGINT), l'API déroule, dans cet ordre : `/ready` bascule en
`503` (l'équilibreur cesse d'envoyer du trafic), le serveur HTTP n'accepte plus
de connexion et laisse finir les requêtes en cours, puis le pool PostgreSQL est
fermé — une écriture comptable est une transaction multi-instructions, la couper
en vol laisse un brouillon orphelin. Le délai de grâce vaut `SHUTDOWN_GRACE_MS`
(10 s par défaut) et doit rester **inférieur** au
`terminationGracePeriodSeconds` de l'orchestrateur, qui enverra SIGKILL. Le
worker suit le même schéma (fermeture de la file, puis du pool).

## Rôles SQL

Deux comptes, deux usages. La séparation est outillée : une migration pose le
modèle de droits, un script crée le rôle de connexion.

| Compte | Qui l'utilise | Droits |
| --- | --- | --- |
| Propriétaire du schéma (`arcompt` en local, compte de migration dédié en production) | `pnpm db:migrate`, `pnpm db:seed`, `scripts/provision-app-role.mts`, `scripts/create-test-account.mts` | DDL, propriétaire des tables |
| `arcompt_app_login` (membre de `arcompt_app`) | API et worker (`DATABASE_URL`) | DML seulement, soumis à la RLS, sans DDL, sans `BYPASSRLS` |

```bash
# une fois par base, avec DATABASE_URL pointant le compte propriétaire
APP_DB_PASSWORD='<mot de passe fort, ≥ 16 caractères>' \
  pnpm exec tsx scripts/provision-app-role.mts
# puis, dans la configuration de l'API et du worker :
DATABASE_URL=postgres://arcompt_app_login:<mot de passe>@<hôte>:5432/<base>
```

Le script crée le rôle de connexion, le rend membre de `arcompt_app`, lui donne
`CONNECT` sur la base, vérifie qu'il n'est ni superutilisateur ni `BYPASSRLS`,
puis **contrôle les 30 droits attendus** (`has_table_privilege`) et sort en
erreur si la base a divergé du schéma. Il est idempotent : relancé avec un autre
mot de passe, il sert de rotation. Variables : `APP_DB_PASSWORD` (obligatoire)
et, pour un autre nom de rôle, `APP_DB_USER` — le nom qu'emploie la tâche de
migration de l'image — ou son synonyme `APP_DB_ROLE`. Aucun mot de passe n'est
écrit dans le dépôt : c'est précisément pourquoi ce rôle ne peut pas naître
d'une migration.

Ce que le rôle applicatif ne peut pas faire, et qui est prouvé par
`packages/db/src/provision.test.ts` : supprimer une clé de paie
(`payroll_tenant_key`), modifier ou supprimer la piste d'audit, écrire dans
`account_balance`, supprimer une ligne de `admin_access_log`, réécrire un accusé
anti-rejeu WhatsApp, lire ou modifier `schema_migration`. L'inaltérabilité d'une
écriture **validée**, elle, reste tenue par les triggers : l'application garde
`UPDATE`/`DELETE` sur `journal_entry` parce qu'elle doit pouvoir travailler ses
brouillons.

> Migration `0010_app_role.sql` : jusqu'à elle, l'`ALTER DEFAULT PRIVILEGES` de
> fin de `0001_core.sql` réaccordait les quatre droits d'écriture sur **toute**
> table créée ensuite, ce qui annulait silencieusement les restrictions des
> migrations suivantes — le rôle applicatif pouvait notamment supprimer la clé
> de chiffrement de la paie d'un dossier, donc rendre ses données de paie
> définitivement illisibles. La migration retire ces privilèges par défaut :
> **toute nouvelle table doit désormais accorder ses droits explicitement**,
> sans quoi l'application recevra un « permission denied » franc au lieu d'un
> excès de droits silencieux.

- Aucun administrateur n'a de droit SQL direct sur les tables comptables en production ; les interventions passent par les procédures du portail (`admin_access_log`, break-glass). Rien dans le dépôt ne l'impose : c'est une règle d'exploitation.

## Compte de test pour un expert-comptable

```bash
DATABASE_URL=<compte propriétaire> \
  pnpm exec tsx scripts/create-test-account.mts --email prenom.nom@cabinet.tg
```

Crée, sur une base vivante : une organisation, un dossier sur le pack pays Togo
(`tg@2025.1`, XOF), l'utilisateur avec une appartenance `OWNER`, deux tiers,
quatre écritures validées (à-nouveaux, vente, achat, règlement) et un brouillon,
pour que les écrans ne soient pas vides. Il imprime les identifiants à
transmettre : identifiant du dossier (`X-Tenant-Id`), identifiant utilisateur
(`X-User-Id`), et la marche à suivre selon `AUTH_MODE`.

- `AUTH_MODE=oidc` : créez dans Keycloak un utilisateur portant **exactement**
  la même adresse, courriel vérifié. Le rattachement au compte ARCOMPT se fait
  tout seul au premier appel (`auth_link_subject`, migration 0009) : aucun SQL à
  la main.
- `AUTH_MODE=dev` (poste local uniquement) : les deux identifiants imprimés
  suffisent, en en-têtes HTTP.

Options : `--name`, `--org`, `--company`, `--year`. Réexécuté à l'identique, le
script ne crée rien et réimprime les informations ; si l'adresse existe dans une
autre configuration, il refuse en disant ce qu'il a trouvé plutôt que d'écraser
un compte. Le pack `tg` est en statut `DRAFT` : taux et barèmes restent
indicatifs tant que l'expert-comptable référent ne les a pas validés.

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

1. Tests de fuite entre dossiers et contrôle du modèle de droits (`pnpm test:tenancy`, qui couvre `db.test.ts` et `provision.test.ts`) sur la version déployée. Sur la base de production, le même contrôle s'obtient en relançant `scripts/provision-app-role.mts` : il revérifie les 30 droits attendus sans rien changer d'autre que le mot de passe fourni.
2. Revue des droits (`GET /v1/portal/org/entitlement-review`) et suspension des comptes inactifs. Les rôles se lisent et se modifient dans `company_member` depuis le portail, avec effet à la requête suivante.
3. Audit du journal des accès administrateur et des demandes break-glass.
4. Vérification des chaînes de hash (`Ledger.verifyChain`) ; la vérification des ancres attendra leur mise en service.
5. Test de restauration.

## Conformité pays

Avant lancement commercial dans un pays : déclaration ou autorisation auprès de l'autorité de protection des données (hébergement hors territoire), validation du pack pays par l'expert-comptable référent (`packages/country-packs/packs/<code>/README.md`), passage du pack en `PUBLISHED`.
