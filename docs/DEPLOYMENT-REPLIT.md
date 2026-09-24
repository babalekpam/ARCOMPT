# Mise en ligne d'ARCOMPT sur Replit

> **LEGACY — cette page décrit l'ancien déploiement Keycloak/Auth.js et ne
> doit pas être exécutée pour le déploiement actuel.** La procédure courante
> est [`DEPLOYMENT-CLERK.md`](DEPLOYMENT-CLERK.md). Les contrôles de base,
> RLS, services et sauvegardes restent obligatoires ; ce changement ne signifie
> pas qu'ARCOMPT est prête à publier.

Le dossier d'ensemble est [`DEPLOYMENT-PACKAGE.md`](DEPLOYMENT-PACKAGE.md) ; la
version impérative destinée à un agent est
[`REPLIT-AGENT-BRIEF.md`](REPLIT-AGENT-BRIEF.md).

Ce guide est la **seconde route de mise en ligne**. La première,
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md), loue un serveur et y fait tourner sept
conteneurs derrière Caddy. Celle-ci ne loue rien : tout vit dans un projet
Replit, et Replit fournit la machine, les certificats et la base de données.

Elle part du même point — le domaine **`arcompt.com`** enregistré chez GoDaddy,
aucun serveur — et s'arrête au même endroit : un expert-comptable se connecte à
`https://arcompt.com` et saisit une écriture.

Prévoir **deux heures** la première fois, dont une bonne demi-heure d'attente
(propagation DNS, vérification du domaine par Replit).

> **Lisez le chapitre [11](#11-ce-que-replit-ne-sait-pas-faire) avant de
> commencer.** Replit fait gagner beaucoup de temps, mais la route serveur
> disposait aussi d'un fournisseur d'identité dédié, d'un disque persistant
> et d'une entrée publique pour les webhooks
> sans un service tiers.

---

## Table des matières

1. [Ce que vous allez obtenir](#1-ce-que-vous-allez-obtenir)
2. [Créer le projet Replit](#2-créer-le-projet-replit)
3. [Un déploiement ou deux ? Et lequel ?](#3-un-déploiement-ou-deux--et-lequel-)
4. [La base de données](#4-la-base-de-données)
5. [Les secrets](#5-les-secrets)
6. [Le fournisseur d'identité](#6-le-fournisseur-didentité)
7. [Les migrations](#7-les-migrations)
8. [Publier](#8-publier)
9. [Brancher le domaine GoDaddy](#9-brancher-le-domaine-godaddy)
10. [Créer le premier compte et vérifier](#10-créer-le-premier-compte-et-vérifier)
11. [Ce que Replit ne sait pas faire](#11-ce-que-replit-ne-sait-pas-faire)
12. [Mettre à jour, revenir en arrière, sauvegarder](#12-mettre-à-jour-revenir-en-arrière-sauvegarder)
13. [Quand ça ne marche pas](#13-quand-ça-ne-marche-pas)
14. [Ce qui n'a pas pu être vérifié](#14-ce-qui-na-pas-pu-être-vérifié)

---

## 1. Ce que vous allez obtenir

```
                         Internet
                            │ 443 (TLS géré par Replit)
                   ┌────────▼─────────┐
                   │  Déploiement     │   arcompt.com
                   │  Replit (1 seul  │
                   │  port exposé)    │
                   │                  │
                   │   web (Next) ────┼──► 127.0.0.1:4000  api (Hono)
                   └────────┬─────────┘                     │
                            │                               │
             ┌──────────────┴───────────┐                   │
             ▼                          ▼                   ▼
   Fournisseur d'identité      Base PostgreSQL        Stockage objet
   hébergé (OIDC)              gérée par Replit       Cloudflare R2
   — hors Replit —                                    — hors Replit —
```

Trois différences de fond avec la route serveur :

- **Un seul processus exposé.** Replit n'accepte **qu'un port externe par
  déploiement**. C'est Next qui le tient ; l'API écoute sur `127.0.0.1:4000` et
  n'est jamais publiée. Ce n'est pas un pis-aller : le navigateur ne parle
  jamais à l'API directement, il passe par `/api/proxy/…` servi par Next, qui
  ajoute le jeton côté serveur. `api.arcompt.com` disparaît donc — et avec lui
  l'entrée des webhooks (§ 11).
- **Pas de Keycloak.** C'est une application Java avec sa propre base ; elle n'a
  pas sa place ici. Il faut un fournisseur d'identité hébergé (§ 6). Le code de
  l'API a été rendu compatible avec n'importe quel fournisseur OpenID Connect
  conforme : il découvre l'URL du trousseau de clés au lieu de la deviner.
- **Pas de Redis, pas de disque persistant.** La file de tâches de l'API est
  persistée dans PostgreSQL ; le système de fichiers d'une application publiée
  est réinitialisé à chaque publication (§ 11).

---

## 2. Créer le projet Replit

### 2.1 Importer le dépôt

Sur `replit.com` : **Create Repl** → onglet **Import from GitHub** → l'URL du
dépôt ARCOMPT. Si le dépôt est privé, Replit demande d'autoriser son
application GitHub sur votre compte.

Le dépôt contient déjà le fichier **`.replit`**, qui décrit tout ce dont Replit
a besoin :

| Clé | Ce qu'elle fait |
|---|---|
| `modules = ["nodejs-20", "postgresql-16"]` | Node 20 (voir `.nvmrc` et le champ `engines` du `package.json`) et le client `psql`, indispensable pour les migrations et les sauvegardes |
| `[nix] packages = ["chromium", "pnpm"]` | Chromium pour le rendu PDF, pnpm pour le monorepo |
| `run` | L'atelier : `pnpm install` puis l'API et le web en mode développement |
| `[[ports]] localPort = 3000 → externalPort = 80` | Le **seul** port exposé |
| `[deployment]` | La commande de construction et celle de démarrage en production |

> **N'ajoutez pas de second `[[ports]]`.** Un déploiement Autoscale ou Reserved
> VM n'accepte qu'un seul `externalPort` ; un second fait échouer la
> publication, sans rapport apparent avec la cause.

Si votre projet possède aussi un fichier **`replit.nix`** (les projets plus
anciens en ont un), les paquets système s'y déclarent à la place de
`[nix] packages` — les deux formes existent, la seconde est la plus récente :

```nix
{ pkgs }:
{
  deps = [ pkgs.chromium pkgs.pnpm ];
}
```

Ne gardez qu'une seule des deux formes, sinon vous ne saurez plus laquelle fait
foi.

### 2.2 Premier démarrage dans l'atelier

Cliquez sur **Run**. Le premier lancement installe les dépendances du monorepo
(plusieurs minutes) puis démarre les deux applications en mode développement.
À ce stade `AUTH_MODE` vaut `dev` : l'application est utilisable sans
fournisseur d'identité, mais **cette configuration est refusée en production**
(`apps/api/src/config.ts`) — c'est exactement ce que l'on veut.

Si l'installation échoue en disant que `pnpm` est introuvable, c'est que le
canal Nix déclaré ne le fournit pas. La commande de démarrage appelle déjà
`corepack enable` en amont, ce qui suffit — Node 20 embarque Corepack. Sinon,
dans le Shell : `corepack prepare pnpm@10.33.0 --activate`.

---

## 3. Un déploiement ou deux ? Et lequel ?

### 3.1 Un seul déploiement, deux processus

**Un seul.** L'API et le web tournent dans le même déploiement, démarrés par la
même commande :

```
KEYCLOAK_CLIENT_ID="$KEYCLOAK_API_AUDIENCE" pnpm --filter @arcompt/api start &
KEYCLOAK_CLIENT_ID="$KEYCLOAK_WEB_CLIENT_ID" pnpm --filter @arcompt/web start &
wait -n
```

Trois raisons, dans l'ordre d'importance :

1. **Replit n'expose qu'un port par déploiement.** Deux services publics
   supposeraient deux projets Replit distincts, donc deux bases de données par
   défaut, deux jeux de secrets à garder synchronisés et deux domaines à
   vérifier.
2. **Rien n'a besoin d'appeler l'API depuis l'extérieur.** Le navigateur passe
   par Next. Le seul appelant externe légitime serait un webhook entrant, et
   aucun n'est branché dans cette configuration (§ 11).
3. **Garder l'API hors d'Internet est un gain**, pas une perte : sa surface
   d'attaque publique se réduit à ce que Next relaie.

Le prix à payer : les deux processus partagent une mémoire et un environnement.
D'où la précaution suivante, qui est le piège n° 1 de ce déploiement.

> **`KEYCLOAK_CLIENT_ID` ne veut pas dire la même chose des deux côtés.** L'API
> y attend l'**audience** exigée dans le jeton (le client « bearer only ») ; le
> web y attend le **client de connexion**. Sur un serveur ce sont deux
> conteneurs, donc deux environnements. Ici, un seul. `.replit` pose donc la
> variable **par processus**, à partir de deux secrets distincts :
> `KEYCLOAK_API_AUDIENCE` et `KEYCLOAK_WEB_CLIENT_ID`.
> **Ne définissez jamais `KEYCLOAK_CLIENT_ID` dans les secrets Replit** : l'une
> des deux applications serait mal configurée, et vous chercheriez longtemps
> d'où viennent les 401.

### 3.2 Reserved VM, pas Autoscale

Replit propose quatre types de publication. Deux conviennent techniquement :

| Type | Comportement | Verdict pour ARCOMPT |
|---|---|---|
| **Autoscale** (`deploymentTarget = "cloudrun"`) | Démarre à la demande, redescend **à zéro instance** quand personne ne s'en sert, facture à la requête | **Déconseillé** |
| **Reserved VM** (`deploymentTarget = "gce"`) | Machine dédiée, allumée en permanence, coût mensuel fixe | **Retenu** |
| Static | Fichiers statiques seulement | Sans objet — il faut un serveur Node |
| Scheduled | Exécution à heure fixe | Utile plus tard pour une sauvegarde nocturne, pas pour l'application |

Pourquoi pas Autoscale, alors que c'est le choix par défaut de Replit :

- **Les tâches planifiées doivent pouvoir tourner sans requête.** Sans Redis,
  l'API consomme une file PostgreSQL persistante ; une instance mise en veille
  retarde les imports et les relances jusqu'à son prochain réveil.
- **Chromium coûte cher à démarrer.** Le rendu PDF lance un navigateur, gardé
  ouvert et réutilisé (`packages/render/src/pdf.ts`). Une veille à zéro le
  refait payer à chaque réveil, et le premier PDF après une pause devient très
  lent.
- **Le pool PostgreSQL aussi.** Chaque instance ouvre ses connexions ; une mise
  à l'échelle les multiplie, face à une base gérée dont le nombre de connexions
  est plafonné.

Choisissez donc **Reserved VM** dans le panneau **Publishing**. Prenez la
taille la plus généreuse que vous acceptez de payer : le raisonnement mémoire
de `docs/DEPLOYMENT.md` § 2 reste valable, moins Keycloak et PostgreSQL —
comptez **2 vCPU et 4 Go** pour être tranquille avec le rendu PDF, moins si
vous acceptez des PDF lents.

---

## 4. La base de données

### 4.1 Créer la base

Dans l'atelier : outil **Database** → **Create a database**. Replit pose une
variable `DATABASE_URL` dans l'environnement du projet ; c'est la seule à
utiliser (les anciennes `PGHOST` / `PGUSER` / `PGPASSWORD` n'existent plus sur
l'infrastructure actuelle).

**La base de l'atelier n'est pas celle de l'application publiée.** Replit crée
une base de production séparée au moment de la publication, et la
`DATABASE_URL` vue par le déploiement n'est pas celle du Shell de l'atelier.
Retenez-le maintenant : c'est la cause première des « migrations appliquées et
pourtant l'application ne démarre pas » (§ 7).

### 4.2 Le rôle applicatif : vérifier AVANT tout le reste

ARCOMPT utilise **deux comptes PostgreSQL distincts** : le propriétaire du
schéma, qui migre, et un rôle de connexion restreint, soumis à la Row-Level
Security, avec lequel l'API travaille. Ce n'est pas un raffinement : le rôle
applicatif ne peut **pas** supprimer une ligne de la piste d'audit, ni
supprimer une clé de chiffrement de paie, ni toucher à l'historique des
migrations (`packages/db/src/provision.ts`, table des droits attendus).

Ce modèle suppose que le compte fourni par Replit ait le droit de **créer des
rôles**. Vérifiez-le tout de suite, dans le Shell de l'atelier :

```bash
psql "$DATABASE_URL" -c "SELECT current_user, rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user"
```

Trois lectures possibles :

| Résultat | Conséquence |
|---|---|
| `rolcreaterole = t` | Tout marche. Continuez au § 7. |
| `rolcreaterole = f` | **Les migrations elles-mêmes échouent** : `packages/db/migrations/0001_core.sql` commence par `CREATE ROLE arcompt_app NOLOGIN`. Sans ce droit, ARCOMPT ne s'installe pas du tout sur cette base. Voir § 4.3. |
| `rolsuper = t` | Inattendu sur une base gérée. À signaler : un superutilisateur **contourne la Row-Level Security**, ce qui annule l'isolation entre dossiers. |

Les bases Replit adossées à Neon donnent un rôle membre de `neon_superuser`,
qui possède `CREATEROLE` : la création fonctionne. Sur l'infrastructure plus
récente de Replit, cela **n'a pas pu être vérifié sans compte** (§ 14) — d'où
la vérification ci-dessus, qui prend dix secondes et évite une heure de
tâtonnement.

Notez au passage que `provisionAppRole` sait déjà composer avec une base gérée :
si la pose explicite de `NOSUPERUSER NOBYPASSRLS` est refusée (code `42501`),
il retombe sur la forme minimale **puis vérifie le résultat obtenu** au lieu de
le supposer. Il échoue bruyamment si le rôle obtenu contourne la RLS.

### 4.3 Si la création de rôle est refusée

Soyons clairs : **il n'y a pas de contournement propre.**

- La migration `0001_core.sql` ne s'applique pas. Vous ne pouvez pas installer
  ARCOMPT sur cette base.
- La seule issue est une **base PostgreSQL ailleurs** : Neon, Supabase, Aiven,
  Scaleway, ou le PostgreSQL de votre hébergeur habituel — n'importe quelle
  base qui donne un compte propriétaire avec `CREATEROLE`. Vous collez alors
  son URL dans un secret `DATABASE_URL` du déploiement, et la base Replit ne
  sert plus.

Et si vous décidiez malgré tout de faire tourner l'application **avec le compte
propriétaire** (un seul rôle, pas de séparation) — ce que ce dépôt ne prévoit
pas et que `provision-app-role.mts` refuse de valider — voici ce qui est perdu,
noir sur blanc :

| Garantie perdue | Ce que cela veut dire concrètement |
|---|---|
| Piste d'audit en insertion seule | Une injection SQL ou un défaut applicatif peut **effacer la trace** de ce qui a été fait |
| Clés de paie non supprimables | Un `DELETE` sur `payroll_tenant_key` rend la paie d'un dossier **définitivement indéchiffrable** |
| Historique des migrations intouchable | Le schéma peut être modifié sous l'application, sans trace |
| Soldes tenus par les seuls triggers | `account_balance` devient écrivable directement : une balance peut mentir sans qu'aucune écriture ne le justifie |
| DDL interdit à l'application | Le compte de l'API peut supprimer une table |
| Row-Level Security | **Conservée** tant que le rôle n'est ni superutilisateur ni `BYPASSRLS` : le schéma pose `FORCE ROW LEVEL SECURITY`, qui s'applique aussi au propriétaire des tables |

Pour la comptabilité d'un tiers, les deux premières lignes suffisent à
disqualifier ce montage.

---

## 5. Les secrets

Replit n'a pas de fichier `.env` : les variables se posent dans l'outil
**Secrets** (clé + valeur). Deux jeux existent, et **c'est le second qui
compte** :

- les secrets de l'**atelier**, vus par le bouton *Run* ;
- les secrets du **déploiement**, vus par l'application publiée. Le panneau de
  publication propose de reprendre ceux de l'atelier ; vérifiez la liste
  obtenue plutôt que de la supposer.

Fabriquez chaque secret avec `openssl rand -base64 32` dans le Shell — un par
variable, jamais le même deux fois.

> **L'API relit toute cette configuration au démarrage et refuse de démarrer si
> quelque chose manque** (`apps/api/src/config.ts`). Elle ne s'arrête pas à la
> première erreur : elle les liste toutes d'un coup, chacune avec sa
> conséquence. Les journaux du déploiement vous donneront donc la liste exacte
> de ce qui manque.

### 5.1 Ce sans quoi l'API refuse de démarrer

Source : `apps/api/src/config.ts`, complété par `packages/mailer` pour la
dernière ligne.

| Secret | Valeur | Sans lui |
|---|---|---|
| `DATABASE_URL` | Posé par Replit, ou l'URL du **rôle applicatif** après le § 7 | Aucune base |
| `KEYCLOAK_ISSUER` | L'émetteur du fournisseur d'identité (§ 6), **sans barre oblique finale** | Aucun jeton vérifiable |
| `KEYCLOAK_API_AUDIENCE` | L'audience exigée dans le jeton. `.replit` la présente à l'API sous le nom `KEYCLOAK_CLIENT_ID` | Audience non vérifiée |
| `PAYROLL_ENCRYPTION_KEY` | `openssl rand -base64 32` — **base64 de 32 octets exactement** | Paie chiffrée avec une clé de développement |
| `ANTHROPIC_API_KEY` **ou** `ALLOW_INSECURE_AI=1` | Clé Anthropic, ou renoncement explicite | Extraction IA **inventée** dans la file de validation |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` **ou** `ALLOW_INSECURE_STORAGE=1` | Cloudflare R2, ou renoncement explicite | Pièces sur le disque local — **effacé à chaque publication sur Replit** (§ 11) |
| `CLAMAV_HOST` **ou** `ALLOW_INSECURE_ANTIVIRUS=1` | Un clamd joignable, ou renoncement | Tout fichier accepté sans analyse |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` + `WHATSAPP_APP_SECRET` | Meta Cloud API, ou canal désactivé | Sans la paire token/téléphone : routes WhatsApp en 503 et tâches worker en échec ; une paire partielle est invalide |
| `SMTP_HOST` + `MAIL_FROM_ADDRESS` **ou** `ALLOW_INSECURE_MAIL=1` | Zoho pour ce déploiement — voir § 5.5 | Invitations au portail jamais remises, **avec leur code à usage unique** |

`AUTH_MODE`, `NODE_ENV`, `API_PORT` et `API_URL` sont posés par `.replit` : ne
les mettez pas dans les secrets.

Deux variables ont changé de statut par rapport à `docs/DEPLOYMENT.md` § 5.3,
et c'est `config.ts` qui fait foi :

- **`WHATSAPP_APP_SECRET` n'est exigée que si le canal WhatsApp est réellement
  configuré.** Lorsque `WHATSAPP_TOKEN` et `WHATSAPP_PHONE_ID` sont tous deux
  absents, le canal reste désactivé ; les routes renvoient 503 et les tâches
  worker échouent sans signaler d'envoi. Une seule des deux variables est une
  configuration invalide. N'inventez pas de valeur aléatoire pour le secret.
- **`PAYMENT_WEBHOOK_SECRET` n'est exigée que si `PAYMENT_PROVIDER` est
  renseigné**, ce qui ne doit pas être le cas (voir ci-dessous).

### 5.2 Ce qui doit rester vide

| Secret | Pourquoi |
|---|---|
| `PAYMENT_PROVIDER` | Aucun opérateur mobile money réel n'est implémenté. La valeur `mock` est **refusée en production, sans échappatoire** : elle accepterait des encaissements fictifs. Vide = fonction proprement désactivée |
| `CERTIFICATION_CONNECTOR` | `mock` imprimerait une référence fiscale et un QR code **inventés** sur les factures de vos clients. Refusé en production |
| `KEYCLOAK_CLIENT_ID` | Posé par processus dans `.replit` (§ 3.1). Le définir ici casse l'un des deux côtés |
| `REDIS_URL` | Optionnel : sans Redis, l'API utilise PostgreSQL pour la file et exécute les tâches elle-même. N'utilisez pas une URL Redis morte |
| `ALLOW_INSECURE_DRAFT_PACK_FILINGS` | Laisse produire déclarations, liasse DSF et dépôts depuis un pack pays non publié. N'empêche pas le démarrage et ne produit rien d'officiel — chaque document part marqué « DOCUMENT NON OFFICIEL » — mais ne le posez que si vous éprouvez sciemment le parcours déclaratif d'un pays dont le pack n'est pas encore publié |

### 5.3 Ce dont le web a besoin

| Secret | Valeur |
|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32`. Chiffre le cookie de session Auth.js |
| `AUTH_URL` | `https://arcompt.com` |
| `KEYCLOAK_WEB_CLIENT_ID` | Le client de **connexion** créé au § 6. `.replit` le présente au web sous le nom `KEYCLOAK_CLIENT_ID` |
| `KEYCLOAK_CLIENT_SECRET` | Le secret de ce client |
| `APP_URL` | `https://arcompt.com` — sert aux liens des courriels et du portail |

### 5.4 Ce qu'il est prudent d'ajouter

| Secret | Effet |
|---|---|
| `SENTRY_DSN` | Sans lui, une erreur ne réveille personne |
| `SECURITY_ALERT_WEBHOOK_URL` | Puits des alertes de sécurité (rafales d'échecs d'authentification, rejets RLS, signatures invalides) |
| `MAIL_LEGAL_FOOTER` | Mentions légales en pied de chaque message. Vide, un texte de rappel part à la place, **visible de vos clients** |
| `DEFAULT_COUNTRY_PACK`, `DEFAULT_CURRENCY`, `DEFAULT_LOCALE` | `ci`, `XOF`, `fr` par défaut |

> **`PAYROLL_ENCRYPTION_KEY` ne se change pas.** Elle déchiffre les données de
> paie déjà enregistrées ; la perdre les rend définitivement illisibles.

### 5.5 Messagerie — Zoho, info@arcompt.com

Six secrets à poser sur Replit. Le code ne connaît aucun fournisseur ; ce sont
les valeurs de ce déploiement.

```
SMTP_HOST=smtppro.zoho.com     ← smtppro, PAS smtp : voir ci-dessous
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=info@arcompt.com
SMTP_PASSWORD=<mot de passe d'application Zoho>
MAIL_FROM_ADDRESS=info@arcompt.com
MAIL_FROM_NAME=ARCOMPT
```

Seul `SMTP_PASSWORD` est un secret ; les cinq autres peuvent être posés en clair
sans risque. Le mot de passe d'application se crée dans `accounts.zoho.com` →
Sécurité → Mots de passe d'application : dédié à ARCOMPT, révocable seul, et
obligatoire dès que la double authentification est active sur la boîte — ce
qu'elle doit être, puisque c'est elle qui expédie les codes d'invitation.

Le piège coûteux : une adresse sur domaine propre passe par `smtppro.zoho.com`.
Le `smtp.zoho.com` des comptes gratuits refuse l'authentification et l'erreur
ressemble à un mot de passe faux. Le suffixe (`.com`, `.eu`, `.in`, `.com.au`)
suit le centre de données du compte Zoho, pas le pays du dossier, et se lit dans
la console Zoho.

**Avant la première invitation réelle**, depuis une machine qui peut sortir en
SMTP (le conteneur de développement ne le peut pas toujours) :

```
pnpm mail:check --to vous@exemple.com
```

puis ouvrez l'en-tête complet du message reçu et exigez `spf=pass` **et**
`dkim=pass`. Les trois enregistrements DNS à publier sur `arcompt.com` chez
GoDaddy sont donnés dans `docs/OPERATIONS.md`.
> Gardez-en une copie **hors de Replit**, dans un gestionnaire de mots de passe.

---

## 6. Le fournisseur d'identité

Keycloak ne tournera pas ici. Il faut un fournisseur OpenID Connect hébergé.

### 6.1 Ce que l'application exige, exactement

| Exigence | Où c'est lu | Ce qui casse sans elle |
|---|---|---|
| **Un émetteur (`issuer`) en HTTPS**, servant `/.well-known/openid-configuration` | `apps/api/src/auth.ts` | L'API ne trouve pas le trousseau de clés et répond **503**, en nommant l'URL interrogée |
| **Un jeton d'accès au format JWT**, signé, vérifiable par ce trousseau | idem | 401 sur tout |
| **Une audience (`aud`) contenant l'identifiant de l'API** | idem | 401 sur tout, sans message utile — c'est la cause n° 1 |
| **Les claims `email` et `email_verified: true` dans le jeton d'accès** | `apps/api/src/identity.ts` | Le rattachement au premier accès est refusé : 403 « compte inconnu ». Volontaire — sinon s'inscrire avec l'adresse d'autrui suffirait à prendre son dossier |
| **Un second facteur prouvé par `amr` (`mfa`, `otp`, `hwk`, `swk`) ou `acr ≥ 2`** | `apps/api/src/auth.ts` | 403 dès qu'une organisation pose `mfa_required` |
| **Une URI de redirection se terminant par `/api/auth/callback/keycloak`** | `apps/web/auth.ts` | La connexion échoue au retour du fournisseur |

Cette dernière ligne surprend : le chemin contient le mot `keycloak` parce que
c'est l'identifiant du fournisseur dans Auth.js, **quel que soit le service
derrière**. Déclarez donc au fournisseur l'URI exacte
`https://arcompt.com/api/auth/callback/keycloak`. Ce n'est pas joli, c'est sans
conséquence.

### 6.2 La découverte, et l'échappatoire

L'API ne devine plus l'URL du trousseau. Elle lit
`${KEYCLOAK_ISSUER}/.well-known/openid-configuration` à la **première requête
portant un jeton** — jamais au démarrage — et en prend `jwks_uri`, puis garde le
résultat. Elle vérifie aussi que le document déclare bien l'émetteur configuré.

Si votre fournisseur ne publie pas de document exploitable, posez le secret :

```
OIDC_JWKS_URI = https://…/keys
```

L'API l'utilise alors tel quel, sans découverte.

### 6.3 Quelques fournisseurs réels

Aucun prix n'est cité ici : ils changent, et la plupart de ces services ont une
offre gratuite pour un petit nombre d'utilisateurs actifs qu'il faut vérifier
soi-même au moment du choix.

| Fournisseur | Ce qu'il faut savoir |
|---|---|
| **Keycloak hébergé** (Cloud-IAM, Phase Two, et autres) | Le chemin le plus court : **rien ne change**. Même forme d'émetteur `…/realms/arcompt`, même correspondant d'audience, mêmes `amr`/`acr`. Les chapitres 8 et 9 de `docs/DEPLOYMENT.md` s'appliquent mot pour mot |
| **Zitadel Cloud** | Sait émettre un jeton d'accès **au format JWT** (réglage explicite) et y ajouter l'audience d'un projet. Convient sans modifier le code |
| **Auth0**, **Okta** | Conformes, mais n'émettent un JWT pour une API que si la demande d'autorisation porte un paramètre `audience` (Auth0) ou un `scope` dédié (Okta). Auth.js ne l'envoie pas aujourd'hui : il faudrait ajouter `authorization: { params: { audience } }` dans `apps/web/auth.ts` — **une ligne, mais hors de ce document** |
| **Microsoft Entra ID** | Même remarque pour le `scope` (`api://<id>/.default`), et **n'émet pas `email_verified`** : le rattachement automatique ne se fera pas, il faudra rattacher chaque compte à la main |
| **Google / Firebase Identity** | Le jeton d'accès Google est opaque, pas un JWT vérifiable par l'API. **Ne convient pas** en l'état |

Autrement dit : un **Keycloak hébergé** ou **Zitadel** se branche sans toucher
au code ; les autres demandent une petite modification côté web que ce guide ne
fait pas.

### 6.4 Le second facteur

Tant qu'aucune organisation ne pose `mfa_required`, rien ne le réclame. Avant
qu'un cabinet utilise réellement l'outil, c'est l'inverse qu'il faut faire :
activer le second facteur chez le fournisseur, vérifier qu'il apparaît dans le
jeton (`amr` ou `acr`), puis :

```sql
UPDATE organization SET mfa_required = true WHERE id = '<uuid>';
```

Vérifiez le contenu du jeton avant de poser ce drapeau : un fournisseur qui
impose bien le second facteur mais ne le **déclare pas** dans le jeton
provoquera un 403 pour tout le monde, sans recours.

---

## 7. Les migrations

**Rien ne les joue toute seule.** Sur la route serveur, le service `migrate` de
`docker-compose.prod.yml` tourne avant l'API et l'empêche de démarrer s'il
échoue. Sur Replit, il n'existe pas d'équivalent dans `.replit` : la commande
de construction (`build`) installe et compile, elle ne migre pas — et elle ne
tourne pas nécessairement avec la `DATABASE_URL` de la base de production.

### 7.1 Quand

**Avant chaque publication**, et dans cet ordre :

1. vous mettez le code à jour ;
2. **vous migrez** ;
3. vous publiez.

> **Une application publiée devant une base non migrée échoue à la première
> requête.** Pas au démarrage : au premier accès qui touche une table ou une
> fonction absente. L'écran de connexion peut très bien s'afficher, et tout
> casser juste après. C'est le piège de cette route ; la route serveur ne
> l'avait pas.

### 7.2 Comment

Dans le **Shell** de Replit, avec la `DATABASE_URL` du **compte propriétaire**
de la base de production — pas celle de l'atelier :

```bash
export DATABASE_URL='postgres://<proprietaire>:<mot_de_passe>@<hote>/<base>?sslmode=require'
pnpm db:migrate
```

Puis, **une seule fois**, la création du rôle applicatif :

```bash
export APP_DB_USER=arcompt_app_login
export APP_DB_PASSWORD='<openssl rand -base64 32, 16 caractères minimum>'
pnpm exec tsx scripts/provision-app-role.mts
```

Le script crée le rôle, le rend membre de `arcompt_app`, puis **vérifie le
modèle de droits obtenu** : que l'application peut faire ce dont elle a besoin,
et surtout qu'elle ne peut pas supprimer une clé de paie, réécrire la piste
d'audit ni toucher à l'historique des migrations. S'il échoue, chaque ligne
nomme la table, le droit et la raison. Ne contournez pas : corrigez.

Il affiche à la fin l'URL à utiliser. **C'est elle** qui va dans le secret
`DATABASE_URL` du déploiement — pas celle du propriétaire. Le compte
propriétaire ne sert plus qu'aux migrations, depuis le Shell.

Relancer le script avec un autre mot de passe est la procédure de rotation.

### 7.3 Où trouver la `DATABASE_URL` de la base de production

L'outil **Database** montre les bases du projet et leurs chaînes de connexion,
et le panneau de publication montre les secrets vus par l'application publiée.
Si vous n'êtes pas certain de parler à la bonne base, la question se tranche :

```bash
psql "$DATABASE_URL" -c "SELECT current_database(), current_user, count(*) FROM schema_migration"
```

Comparez ce compte au nombre de fichiers de `packages/db/migrations/`.

### 7.4 Rendre la chose moins fragile

Le panneau de publication permet de déclarer une **commande de pré-déploiement**
(*pre-deploy command*), jouée avant que la nouvelle version ne prenne le
trafic. Y mettre `pnpm db:migrate` reproduit approximativement le garde-fou du
serveur : une migration en échec empêche la publication d'aboutir. Faites-le si
vous le pouvez — **mais vérifiez d'abord, sur une base jetable, que cette étape
voit bien la base de production** : c'est le point que ce guide n'a pas pu
vérifier sans compte (§ 14).

> **Les migrations ne vont que dans un sens.** Il n'existe aucun script de
> retour arrière. D'où la sauvegarde du § 12.

---

## 8. Publier

1. Panneau **Publishing** → type **Reserved VM** (§ 3.2).
2. Vérifiez les commandes reprises de `.replit` (construction et démarrage).
3. **Vérifiez la liste des secrets du déploiement**, une par une, avec le
   chapitre 5 sous les yeux. Une seule manquante, et l'API s'arrête en le
   disant.
4. Publiez. Le premier déploiement installe le monorepo et compile Next :
   comptez plusieurs minutes.
5. Ouvrez l'URL `…replit.app` fournie. La page de connexion doit s'afficher.

Si l'application ne démarre pas, les journaux du déploiement contiennent la
liste complète des problèmes de configuration, chacun avec sa conséquence.

---

## 9. Brancher le domaine GoDaddy

Replit ne donne pas une adresse IP à pointer : il **fournit lui-même les deux
enregistrements** à créer, et l'un d'eux sert à prouver que le domaine est à
vous.

### 9.1 Où trouver les valeurs

Dans Replit : déploiement publié → **Publishing** (ou **Deployments**) →
**Domains** (ou **Settings** → *Link a domain*) → **Connect your own domain** →
saisissez `arcompt.com`.

Replit affiche alors deux lignes, à recopier **telles quelles** :

- un enregistrement **A** avec une adresse IP (celle de Replit, pas la vôtre) ;
- un enregistrement **TXT** dont la valeur commence par `replit-verify=`.

> **Ne réutilisez pas les valeurs d'un exemple trouvé ailleurs, ni celles de ce
> document.** Elles sont propres à votre déploiement et changent.

### 9.2 Les enregistrements à créer chez GoDaddy

| Type | Nom (« Host ») | Valeur (« Points to ») | TTL |
|---|---|---|---|
| **A** | `@` | L'adresse IP affichée par Replit | 600 secondes |
| **TXT** | `@` | `replit-verify=…` affiché par Replit | 600 secondes |

Puis, si vous voulez que `www.arcompt.com` fonctionne — et c'est souhaitable,
beaucoup de gens le tapent :

1. **Ajoutez `www.arcompt.com` comme un second domaine dans Replit.** Un
   sous-domaine n'est pas couvert par le domaine nu : Replit ne délivre pas de
   certificat générique.
2. Replit affiche un second couple de valeurs. Créez-les :

| Type | Nom (« Host ») | Valeur | TTL |
|---|---|---|---|
| **A** | `www` | L'adresse IP affichée pour `www` | 600 secondes |
| **TXT** | `www` | Le `replit-verify=…` affiché pour `www` | 600 secondes |

Chez GoDaddy, le champ *Nom* ne contient que la partie gauche : `@` désigne
`arcompt.com`, `www` donne `www.arcompt.com`. **N'écrivez pas
`www.arcompt.com`** dans ce champ, vous obtiendriez `www.arcompt.com.arcompt.com`.

### 9.3 Cinq pièges, dont quatre propres à GoDaddy

- **Un enregistrement `A` sur `@` existe déjà**, vers la page de parking de
  GoDaddy. **Modifiez-le** (icône crayon), n'en ajoutez pas un second : deux
  enregistrements A sur le même nom enverraient la moitié des visiteurs chez
  GoDaddy.
- **Un `CNAME` `www` existe probablement**, lui aussi vers le parking.
  Supprimez-le : `www` prend ici un enregistrement **A**, et un nom ne peut pas
  porter à la fois un CNAME et un A.
- **Désactivez le « Transfert de domaine »** (*Forwarding*) s'il est actif : il
  prend le pas sur vos enregistrements.
- **Supprimez tout enregistrement `AAAA`** (IPv6) sur `@` et `www` : ils
  empêchent la délivrance du certificat.
- **Le TXT `replit-verify=` reste en place pour toujours.** Il ne sert pas
  qu'à la vérification initiale : Replit s'en sert aussi pour **renouveler** le
  certificat. Le retirer une fois le site en ligne le fait expirer quelques
  semaines plus tard, et le site devient inaccessible sans que rien n'ait
  changé ce jour-là.

Si les serveurs de noms d'`arcompt.com` ont un jour été délégués ailleurs
(Cloudflare, par exemple), les enregistrements saisis chez GoDaddy ne servent à
rien : créez-les chez l'autre fournisseur. Et sous Cloudflare, mettez les
entrées A en **DNS only** (nuage gris) : le mode mandataire empêche Replit
d'établir son certificat.

### 9.4 Vérifier

Depuis votre poste :

```bash
dig +short arcompt.com
dig +short www.arcompt.com
dig +short TXT arcompt.com
```

Les deux premières doivent rendre les adresses données par Replit, et **rien
d'autre**. La troisième doit montrer le `replit-verify=…`. Sous Windows :
`nslookup arcompt.com` et `nslookup -type=TXT arcompt.com`.

Replit passe ensuite le domaine de *Verifying* à *Active*. Comptez de quelques
minutes à quelques heures ; le DNS peut mettre jusqu'à 48 heures à se propager
partout.

Une fois le domaine actif, remettez `AUTH_URL` et `APP_URL` sur
`https://arcompt.com` s'ils pointaient encore l'URL `…replit.app`, déclarez
l'URI de redirection définitive chez le fournisseur d'identité (§ 6.1), et
republiez.

---

## 10. Créer le premier compte et vérifier

### 10.1 Le compte côté ARCOMPT

ARCOMPT n'a pas de super-administrateur global : le premier responsable est
`OWNER` sur un dossier précis. Depuis le Shell, avec une `DATABASE_URL`
pointant **le compte d'administration/migration de la base visée** (et non le
rôle applicatif), préparez d'abord un aperçu en lecture seule :

```bash
corepack pnpm exec tsx scripts/create-first-owner.mts \
  --email prenom.nom@cabinet.ci --name "Prénom Nom" \
  --org "Cabinet Exemple" --kind FIRM --company "Société Exemple" \
  --country ci --year 2026
```

Vérifiez le nom de la base et les paramètres affichés, puis relancez **la même
commande** avec `--apply --confirm-db NOM_DE_LA_BASE_AFFICHEE`. Rien n'est créé
sans ces deux options. Le script crée l'organisation, le dossier, le plan de
comptes et l'exercice, puis rattache l'utilisateur comme `OWNER` ; **aucun
tiers, solde ni écriture de démonstration** n'est ajouté. Il refuse une adresse
déjà attribuée à une autre configuration ou toute base déjà peuplée. Une
relance identique reconnaît le compte existant sans ajouter de données.
La création est atomique : en cas d'erreur, aucune organisation partielle n'est
conservée. Une base déjà peuplée (notamment par un seed de démonstration) est
refusée : utilisez une base vierge, sans supprimer les données existantes.
Un cabinet (`--kind FIRM`) exige la MFA ; pour une PME autonome, utilisez
`--kind COMPANY`. Les packs pays non publiés restent indicatifs.

`scripts/create-test-account.mts` est réservé aux **tests** : il fabrique des
tiers et des écritures fictifs et ne doit pas servir à initialiser un vrai
dossier client. Le bootstrap n'annule aucun des contrôles `preflight` et ne
remplace pas la configuration des services de production.

### 10.2 L'identité côté fournisseur

Créez l'utilisateur avec **exactement la même adresse**, et **marquez-la
vérifiée**. Sans cela le rattachement automatique est refusé, délibérément.
Le bootstrap ne crée aucun mot de passe : l'identité et la MFA sont gérées par
le fournisseur OIDC. N'utilisez jamais `AUTH_MODE=dev` en production.

**Réinitialisation du mot de passe du premier OWNER (et des autres membres).**
Configurez le fournisseur d'identité pour autoriser la récupération par e-mail
vérifié. Avec Keycloak, activez **Forgot password** dans les paramètres du realm
et configurez son propre serveur SMTP et son expéditeur : le SMTP d'ARCOMPT
sert aux invitations, **pas** aux messages de réinitialisation Keycloak. Sur
`/login`, cliquez « Mot de passe oublié ? », puis utilisez l'option de
réinitialisation sur la page du fournisseur. Celui-ci envoie le lien temporaire
et applique sa politique de mot de passe ; ARCOMPT ne reçoit ni le code ni le
nouveau mot de passe. Un opérateur peut aussi déclencher une action temporaire
**Update Password** dans la console du fournisseur pour le premier OWNER, sans
transmettre un mot de passe permanent en clair.

Avant de servir de vrais comptes, vérifiez avec une boîte e-mail de test que
le message arrive, que le lien expire et ne fonctionne qu'une fois, que
l'ancien mot de passe ne permet plus de se connecter, puis que le nouvel accès
conserve la MFA et le rôle OWNER. Si le fournisseur ne propose pas de
récupération par mot de passe (connexion SSO sans mot de passe local), utilisez
son mécanisme de récupération propre ; ne créez pas de mot de passe ARCOMPT.

### 10.3 Le parcours qui prouve que la chaîne tient

1. se connecter sur `https://arcompt.com` ;
2. ouvrir le dossier, aller au grand livre ;
3. saisir une écriture équilibrée et la valider ;
4. **essayer d'en saisir une déséquilibrée** : elle doit être refusée par la
   base, pas seulement par l'écran ;
5. ouvrir les états financiers et **télécharger un PDF** — c'est le seul test
   qui exerce Chromium ;
6. **téléverser une pièce justificative, puis republier le déploiement, puis
   rouvrir la pièce.** Si `ALLOW_INSECURE_STORAGE=1` est posé, elle a disparu.
   C'est le § 11 en action ; faites-le une fois pour le voir de vos yeux.

---

## 11. Ce que Replit ne sait pas faire

| Sujet | État sur Replit | Conséquence |
|---|---|---|
| **Stockage des pièces** | Le système de fichiers d'une application publiée **n'est pas persistant : il est réinitialisé à chaque publication** | Avec `ALLOW_INSECURE_STORAGE=1`, toute pièce justificative disparaît au déploiement suivant. La conservation décennale AUDCIF devient impossible. **Cloudflare R2 n'est pas optionnel ici** — c'est la seule différence vraiment bloquante avec la route serveur |
| **File de tâches** | Sans Redis, l'API dépose et consomme les tâches dans PostgreSQL (`background_job`) | Les extractions et imports reprennent après redémarrage. Une relance interrompue reste en échec pour vérification humaine afin d'éviter un double envoi |
| **Worker séparé** | Inutile sans Redis : le consommateur PostgreSQL tourne dans l'API | Ne lancez `pnpm worker` que si `REDIS_URL` est configuré |
| **Webhooks entrants** | `api.arcompt.com` n'existe plus | WhatsApp entrant et webhooks de paiement sont injoignables. Sans objet tant que ces canaux ne sont pas branchés — à rouvrir le jour où ils le seront |
| **Antivirus** | Aucun clamd à faire tourner à côté | `ALLOW_INSECURE_ANTIVIRUS=1` ou un service d'analyse externe |
| **Keycloak** | Application Java avec sa propre base : hors sujet ici | Fournisseur hébergé obligatoire (§ 6) |
| **Deux comptes PostgreSQL** | Dépend du droit `CREATEROLE` sur la base gérée (§ 4.2) | À vérifier avant tout le reste ; sans lui, ARCOMPT ne s'installe pas |
| **Haute disponibilité** | Une seule machine | Toute publication coupe le service quelques dizaines de secondes |
| **Sauvegardes** | À la charge de l'exploitant (§ 12.3) | Sans elles, une fausse manœuvre est définitive |
| **Où vivent les données** | Les régions Replit sont aux États-Unis | À peser si un client exige que sa comptabilité reste en Europe ou en Afrique de l'Ouest. La route serveur laisse ce choix, pas celle-ci |

Voir aussi la section « Ce qui n'est pas encore de la production » de
`docs/DEPLOYMENT.md`, qui reste valable ici : IA simulée, facture non certifiée,
encaissement mobile money absent.

---

## 12. Mettre à jour, revenir en arrière, sauvegarder

### 12.1 Mettre à jour

```
git pull (ou synchronisation GitHub depuis l'atelier)
pnpm db:migrate          ← contre la base de PRODUCTION (§ 7.2)
Publishing → Redeploy
```

L'ordre n'est pas négociable : voir l'avertissement du § 7.1.

### 12.2 Revenir en arrière

Replit garde l'historique des déploiements et sait en **remettre un précédent
en ligne**. Cela remet le **code** en arrière, jamais le **schéma** : une
migration appliquée reste appliquée. Si la version précédente ne sait pas
travailler avec le nouveau schéma, il faut restaurer la base (§ 12.3).

### 12.3 Sauvegarder

Deux choses, par ordre d'importance :

1. **La base** — toute la comptabilité :

```bash
pg_dump -Fc --no-owner --no-privileges "$DATABASE_URL" -f arcompt-$(date +%Y%m%d).dump
```

   **Copiez le fichier hors de Replit** : le disque du projet n'est pas une
   sauvegarde. Restauration :

```bash
pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" arcompt-20260101.dump
```

   La restauration recrée le rôle de groupe `arcompt_app` mais **pas** le rôle
   de connexion : rejouez `provision-app-role.mts` (§ 7.2) après.

2. **Les secrets**, en particulier `PAYROLL_ENCRYPTION_KEY`, dans un
   gestionnaire de mots de passe.

Une sauvegarde qui n'a jamais été restaurée n'est pas une sauvegarde : essayez
au moins une fois sur une base jetable. Un déploiement **Scheduled** peut jouer
ce `pg_dump` chaque nuit, à condition qu'il dépose le fichier ailleurs que sur
le disque du projet.

---

## 13. Quand ça ne marche pas

**Le premier réflexe** : les journaux du déploiement (panneau *Publishing* →
*Logs*), et ceux de l'atelier pour ce qui s'y passe.

### L'application ne démarre pas

Cherchez `Configuration de production invalide` : l'API liste **tous** les
problèmes d'un coup, avec la conséquence de chacun. Les oublis les plus
fréquents ici :

| Message | Cause |
|---|---|
| `AUTH_MODE : doit valoir « oidc »` | Un secret `AUTH_MODE` posé à la main écrase celui de `.replit` — retirez-le |
| `PAYROLL_ENCRYPTION_KEY : base64 de 32 octets attendu` | Clé tronquée, ou autre chose que `openssl rand -base64 32` |
| `KEYCLOAK_ISSUER : absent` | Le secret n'a pas été repris dans le **déploiement** (§ 5) |
| `PAYMENT_PROVIDER : vaut « mock »` | Laissez la variable vide |
| `SMTP_HOST et MAIL_FROM_ADDRESS sont absents` | Posez-les, ou `ALLOW_INSECURE_MAIL=1` en connaissance de cause |

### Tout renvoie 503 « Fournisseur d'identité inexploitable »

C'est la découverte OpenID Connect qui échoue, et le message **nomme l'URL
interrogée**. Dans l'ordre :

1. `KEYCLOAK_ISSUER` est mal écrit, ou porte une barre oblique finale ;
2. le document de découverte déclare un autre émetteur que celui configuré —
   le message le dit explicitement ;
3. le fournisseur ne publie pas de document conforme : posez `OIDC_JWKS_URI`
   (§ 6.2).

### Tout renvoie 401 après la connexion

1. **L'audience manque dans le jeton.** Cause n° 1. Le jeton d'accès doit
   porter `KEYCLOAK_API_AUDIENCE` dans son claim `aud`.
2. **Le fournisseur émet un jeton opaque** et non un JWT (§ 6.3).
3. **`KEYCLOAK_CLIENT_ID` a été posé dans les secrets** et écrase la valeur que
   `.replit` donne à chaque processus (§ 3.1).
4. L'horloge, ou un `KEYCLOAK_ISSUER` qui ne correspond pas exactement à
   l'émetteur du jeton.

Pour trancher : copiez le jeton d'accès depuis les outils de développement du
navigateur et décodez son deuxième segment (`aud`, `iss`, `exp`, `email`,
`email_verified`).

### Connexion acceptée, mais 403 partout

- **Rattachement non fait** : l'adresse diffère entre le fournisseur et
  `app_user`, ou `email_verified` n'est pas émis (§ 6.1).
- **Second facteur manquant** alors que l'organisation l'exige.
- **Aucune appartenance** : l'utilisateur n'est membre d'aucun dossier.

```bash
psql "$DATABASE_URL" -c "SELECT email, keycloak_sub IS NOT NULL AS rattache, suspended_at FROM app_user"
```

### Une page casse à la première requête, l'écran de connexion s'affichait

Base non migrée (§ 7.1). Migrez, puis republiez.

### Le téléchargement d'un PDF échoue

`Chromium introuvable` : `chromium` n'est pas dans les paquets Nix, ou
`CHROMIUM_PATH` ne pointe rien. Dans le Shell : `command -v chromium`. Une
erreur de mémoire signifie que la machine du déploiement est trop petite.

### Les pièces téléversées ont disparu

Le système de fichiers a été réinitialisé par une publication (§ 11).
Configurez R2. Ce qui a disparu ne revient pas.

### La publication échoue sans message clair

Un second `externalPort` a été ajouté dans `.replit` (§ 2.1), ou le serveur
écoute sur `127.0.0.1` au lieu de `0.0.0.0` pour le port publié.

---

## 14. Ce qui n'a pas pu être vérifié

Ce guide a été écrit à partir de la documentation de Replit et du code de ce
dépôt, **sans compte Replit**. Quatre points sont à confirmer au premier
passage, et à corriger ici s'ils diffèrent :

1. **Le droit `CREATEROLE`** sur la base gérée par Replit. La vérification du
   § 4.2 prend dix secondes et tranche ; toute la séparation des comptes
   PostgreSQL en dépend, et les migrations elles-mêmes avec.
2. **La valeur exacte de `deploymentTarget`.** `"gce"` pour Reserved VM et
   `"cloudrun"` pour Autoscale sont les valeurs documentées ; le panneau
   *Publishing* est la source de vérité et réécrit la clé si vous y changez le
   type de déploiement.
3. **La commande de pré-déploiement** (§ 7.4) : qu'elle voie bien la
   `DATABASE_URL` de la base de **production** et non celle de l'atelier. Tant
   que ce n'est pas vérifié, migrez à la main.
4. **La disponibilité de `pnpm` dans le canal Nix `stable-24_05`.** Si le paquet
   manque, `corepack enable` (déjà appelé par `.replit`) suffit.
