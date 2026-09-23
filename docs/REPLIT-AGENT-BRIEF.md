<!--
SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-->

# Consigne à l'agent Replit

Ce document s'adresse à un **agent**, pas à un lecteur. Il est impératif, il est
borné, et il dit ce qu'il ne faut pas faire avant de dire quoi faire.

Le dossier complet, avec les explications, est
[`DEPLOYMENT-PACKAGE.md`](DEPLOYMENT-PACKAGE.md). La procédure Replit écran par
écran est [`DEPLOYMENT-REPLIT.md`](DEPLOYMENT-REPLIT.md). **En cas de
contradiction avec ce document, ces deux-là ont raison.**

---

## 0. Règles d'engagement

| Interdit | Pourquoi |
| --- | --- |
| Modifier `eslint.config.mjs` | protégé ; toute modification est rejetée |
| Ajouter un second `[[ports]]` dans `.replit` | Replit n'expose qu'un port ; la publication échoue |
| Poser `KEYCLOAK_CLIENT_ID` dans les secrets | l'API et le web n'y attendent pas la même valeur (§ 3) |
| Poser `AUTH_MODE=dev` | accepte l'en-tête `X-Tenant-Id` **sans jeton** : n'importe qui entre dans n'importe quel dossier |
| Renseigner `PAYMENT_PROVIDER` ou `CERTIFICATION_CONNECTOR` | aucun connecteur réel n'existe ; un simulateur annoncerait des règlements et des références fiscales inventés |
| Lancer les migrations avec le compte applicatif | il n'a pas le DDL, et ne doit pas l'avoir |
| Laisser `DATABASE_URL` sur le compte propriétaire après les migrations | il est `BYPASSRLS` : la RLS ne protégerait rien |
| Inventer une valeur de secret | un secret inventé démarre, puis casse en silence |
| `git push --force` sur la branche | — |
| Publier alors que `pnpm preflight` rend une ligne ✗ | c'est précisément ce que cette commande existe pour empêcher |

**Quand une information manque, arrêtez-vous et demandez-la.** La liste de ce
que vous ne pouvez pas fabriquer est au § 1.

---

## 1. Ce que seul un humain peut fournir

N'allez pas plus loin sans ces sept éléments :

1. `DATABASE_URL` de la base de production **et** l'indication de savoir s'il
   s'agit du compte propriétaire ou du compte applicatif ;
2. l'URL du realm OIDC (`KEYCLOAK_ISSUER`) et les deux identifiants de client
   (audience de l'API, client de connexion du web) + le secret du client web ;
3. le mot de passe d'application Zoho pour `info@arcompt.com` ;
4. les quatre valeurs R2 (compte, clé, secret, bucket) ;
5. `PAYROLL_ENCRYPTION_KEY` — 32 octets base64 — **et confirmation qu'elle est
   conservée ailleurs qu'ici** ;
6. la clé Anthropic, ou la consigne explicite d'accepter l'extraction simulée ;
7. l'accès à la zone DNS d'arcompt.com chez GoDaddy.

---

## 2. La base de données

Dans cet ordre, sans permutation.

```bash
# 1. Migrations, sous le compte PROPRIÉTAIRE du schéma.
DATABASE_URL='<url_proprietaire>' pnpm db:migrate
# attendu : « 16 migration(s) appliquée(s) », la dernière étant 0016_locale.sql

# 2. Rôle de connexion applicatif, une fois par base, toujours après les migrations.
DATABASE_URL='<url_proprietaire>' APP_DB_PASSWORD='<16 caractères minimum>' \
  pnpm exec tsx scripts/provision-app-role.mts
# attendu : « membre de : arcompt_app », « superuser=false bypassrls=false »,
#           « 30 contrôles has_table_privilege »

# 3. Basculer DATABASE_URL des secrets sur le rôle produit à l'étape 2.
```

L'étape 2 avant l'étape 1 échoue : ce sont les migrations qui créent le rôle de
groupe `arcompt_app` et posent ses droits.

Si la création de rôle est refusée (`CREATEROLE` absent chez l'hébergeur de la
base), **arrêtez-vous** et signalez-le : `DEPLOYMENT-REPLIT.md` § 4.3 décrit la
sortie, elle demande une décision humaine.

---

## 3. Les secrets

Panneau « Secrets » de l'atelier, **et** secrets de publication : les deux sont
distincts, et seul le second sert au déploiement.

### Bloquants — sans eux, l'API ne démarre pas

```
DATABASE_URL                 le rôle applicatif (§ 2), jamais le propriétaire
AUTH_MODE                    oidc
KEYCLOAK_ISSUER              l'URL du realm, au caractère près
KEYCLOAK_API_AUDIENCE        l'audience exigée par l'API   (client bearer-only)
KEYCLOAK_WEB_CLIENT_ID       le client de connexion du web (code flow)
KEYCLOAK_CLIENT_SECRET       le secret du client web
AUTH_SECRET                  openssl rand -base64 32
PAYROLL_ENCRYPTION_KEY       32 octets base64 EXACTEMENT
```

**`KEYCLOAK_CLIENT_ID` ne figure pas dans cette liste et ne doit pas y figurer.**
`.replit` la pose **par processus** au démarrage, depuis `KEYCLOAK_API_AUDIENCE`
pour l'API et `KEYCLOAK_WEB_CLIENT_ID` pour le web. La poser dans les secrets
donnerait la même valeur aux deux, et des 401 partout.

`.replit` pose aussi lui-même `NODE_ENV=production`, `AUTH_MODE=oidc`,
`API_PORT=4000`, `API_URL=http://127.0.0.1:4000` et `CHROMIUM_PATH` : ne les
dupliquez pas dans les secrets.

### Fortement recommandés

```
R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
   sans eux, les pièces vont sur le disque du déploiement et DISPARAISSENT
   à la republication. Sur Replit, ce n'est pas une nuance.
SMTP_HOST=smtppro.zoho.com  SMTP_PORT=465  SMTP_SECURE=1
SMTP_USER=info@arcompt.com  SMTP_PASSWORD=<mot de passe d'application>
MAIL_FROM_ADDRESS=info@arcompt.com  MAIL_FROM_NAME=ARCOMPT  MAIL_LEGAL_FOOTER=…
ANTHROPIC_API_KEY  AI_MODEL
SECURITY_ALERT_WEBHOOK_URL
```

Quatre pièges Zoho, dans l'ordre où ils se rencontrent : `smtppro`, pas `smtp` ;
suffixe selon le centre de données du compte (`.com`, `.eu`, `.in`, `.com.au`) ;
mot de passe **d'application**, pas celui de la boîte ; `SMTP_USER` identique à
`MAIL_FROM_ADDRESS`.

### Doivent rester vides

```
PAYMENT_PROVIDER             vide
CERTIFICATION_CONNECTOR      vide
KEYCLOAK_CLIENT_ID           absent des secrets (voir ci-dessus)
```

### Opt-out : uniquement sur consigne explicite

`ALLOW_INSECURE_AI`, `ALLOW_INSECURE_STORAGE`, `ALLOW_INSECURE_ANTIVIRUS`,
`ALLOW_INSECURE_WHATSAPP`, `ALLOW_INSECURE_MAIL`. Chacun coupe ou simule une
fonction. N'en posez aucun de votre propre initiative ; si on vous en demande
un, écrivez dans votre compte rendu lequel et ce qu'il coupe.

---

## 4. Publier

Les réglages sont déjà dans `.replit` — ne les changez pas :

- `deploymentTarget = "gce"` → **Reserved VM**, pas Autoscale. L'API garde un
  navigateur Chromium et une file de tâches **en mémoire** : une instance mise
  en veille ou dupliquée les perd.
- build : `pnpm install --frozen-lockfile && pnpm --filter @arcompt/web build`
- run : deux processus dans un seul déploiement, `KEYCLOAK_CLIENT_ID` posée pour
  chacun.
- un seul port : 3000 → 80.

**Les migrations ne sont pas jouées au démarrage.** Replit n'a pas d'équivalent
du service `migrate` de `docker-compose.prod.yml` : le § 2 se fait à la main,
avant de publier, et à nouveau après toute mise à jour qui ajoute une migration.

---

## 5. Le contrôle, avant de publier

```bash
pnpm preflight
```

Aucune ligne **✗** ne doit rester. Le code de sortie vaut 1 s'il en reste une.

Puis, une fois publié :

```bash
pnpm preflight --url https://arcompt.com
pnpm mail:check --to <une adresse que vous relevez>
```

Attendu :

| Contrôle | Réponse attendue |
| --- | --- |
| `Compte applicatif` | « ni superuser ni bypassrls » |
| `Isolation par dossier` | « RLS activée ET forcée sur les 61 tables portant tenant_id » |
| `Droits SQL` | « les 30 contrôles du modèle de droits passent » |
| `Migrations` | 16 appliquées, ou « historique illisible depuis ce compte » — qui est **la bonne réponse** pour le rôle restreint |
| `Découverte OIDC` | l'émetteur et les clés publiques répondent |
| `Accès anonyme` (en ligne) | **401**. Un 200 est un incident : arrêtez le déploiement |
| `pnpm mail:check` | message reçu, `spf=pass` **et** `dkim=pass` dans l'en-tête complet |

Deux points ne se vérifient pas d'ici, et `preflight` le dit plutôt que de les
supposer : le **correspondant d'audience** OIDC (il faut se connecter et ouvrir
un écran de données) et **SPF/DKIM** (ils se lisent chez le destinataire).

---

## 6. DNS, chez GoDaddy

Quatre enregistrements, aucun de plus :

| Type | Nom | Valeur |
| --- | --- | --- |
| A ou CNAME | `@` / `www` | ce que le panneau de publication Replit indique |
| TXT | `@` | `v=spf1 include:zoho.com ~all` |
| CNAME | `zmail._domainkey` | la valeur donnée par la console Zoho |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:info@arcompt.com` |

**Un seul enregistrement SPF par domaine.** Deux enregistrements `v=spf1` sur
`@` donnent un `PermError` et **aucun des deux** ne s'applique : les invitations
partent en indésirables. S'il en existe déjà un, fusionnez `include:zoho.com`
dedans, n'en ajoutez pas un second.

---

## 7. Conditions d'arrêt

Arrêtez-vous et demandez, plutôt que de décider :

1. `pnpm preflight` rend une ligne ✗ que le § 3 ne permet pas de lever.
2. La création du rôle applicatif est refusée.
3. Un secret manque et vous seriez tenté d'en fabriquer un.
4. Une migration échoue, ou la base contient déjà des données.
5. `Accès anonyme` répond 200.
6. La publication échoue deux fois pour la même raison.

---

## 8. Compte rendu attendu

À la fin, rendez exactement ceci :

- la sortie complète de `pnpm preflight --url …` ;
- la liste des secrets posés (**noms seulement, jamais les valeurs**) ;
- les opt-out posés, s'il y en a, et ce que chacun coupe ;
- les enregistrements DNS créés ;
- ce qui reste à faire par un humain : les trois parcours de
  `DEPLOYMENT-PACKAGE.md` § 7.

Ne déclarez jamais la plateforme « prête » sur la seule foi d'un démarrage
réussi. Elle démarre très bien sans pouvoir envoyer un seul message.

---

*ARCOMPT — une plateforme ARGILETTE.*
