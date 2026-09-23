<!--
SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
-->

# Dossier de mise en ligne — la plateforme entière

Ce document est le **point d'entrée unique** pour mettre ARCOMPT en ligne. Il ne
remplace pas les deux procédures pas-à-pas existantes ; il les ordonne, et il
ajoute ce qu'aucune des deux ne contenait : l'inventaire complet de ce qui
compose la plateforme, ce qui casse quand un morceau manque, et **une commande
qui éprouve l'ensemble avant de publier**.

| Vous voulez… | Lisez |
| --- | --- |
| comprendre ce qu'il faut réunir, et dans quel ordre | **ce document** |
| la route Replit, écran par écran | [`DEPLOYMENT-REPLIT.md`](DEPLOYMENT-REPLIT.md) |
| la route serveur (Docker + Caddy), commande par commande | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| confier la mise en ligne à un agent | [`REPLIT-AGENT-BRIEF.md`](REPLIT-AGENT-BRIEF.md) |
| exploiter, sauvegarder, tourner les clés, ancrer | [`OPERATIONS.md`](OPERATIONS.md) |

La règle qui gouverne tout le reste : **ARCOMPT ne sert jamais une comptabilité
depuis un simulateur.** L'API rassemble tous les manques et refuse de démarrer
en les listant (`apps/api/src/config.ts`). Accepter une dépendance simulée est
possible, mais cela se pose explicitement (`ALLOW_INSECURE_*=1`), se relit
(`grep -r ALLOW_INSECURE_`), et se paie — chaque ligne du tableau § 2 dit
exactement en quoi.

---

## Table des matières

1. [Ce que « la plateforme entière » recouvre](#1-ce-que--la-plateforme-entière--recouvre)
2. [Ce qui casse sans chaque morceau](#2-ce-qui-casse-sans-chaque-morceau)
3. [Choisir la route](#3-choisir-la-route)
4. [L'ordre des opérations](#4-lordre-des-opérations)
5. [Le tableau complet des variables](#5-le-tableau-complet-des-variables)
6. [La preuve : `pnpm preflight`](#6-la-preuve--pnpm-preflight)
7. [Le parcours humain, celui qu'aucun script ne remplace](#7-le-parcours-humain-celui-quaucun-script-ne-remplace)
8. [Conditions d'arrêt](#8-conditions-darrêt)
9. [Le lendemain de la mise en ligne](#9-le-lendemain-de-la-mise-en-ligne)
10. [Ce que ce dossier ne couvre pas](#10-ce-que-ce-dossier-ne-couvre-pas)

---

## 1. Ce que « la plateforme entière » recouvre

Cinq processus, une base, et huit services extérieurs. Rien d'autre.

### Ce qui tourne

| Processus | Ce que c'est | Port | Obligatoire |
| --- | --- | --- | --- |
| **API** | Hono, tous les modules métier, webhooks entrants | 4000 | oui |
| **Web** | Next.js : l'application, la PWA hors ligne, le proxy authentifié `/api/proxy` | 3000 | oui |
| **Worker** | tâches de fond : extraction IA des pièces, réponses WhatsApp, relances | — | oui en pratique¹ |
| **PostgreSQL 16** | toute la comptabilité, avec la RLS forcée par dossier | 5432 | oui |
| **Redis 7** | file de tâches durable | 6379 | non² |

¹ Sans worker, les pièces téléversées restent en attente d'extraction : rien ne
se perd, rien n'avance. Sur Replit il n'existe pas de troisième processus : les
tâches s'exécutent **dans l'API**, en mémoire (voir § 3).

² Sans `REDIS_URL`, la file vit dans le processus. Une tâche en cours est perdue
au redémarrage ; les tâches en attente aussi. Acceptable pour un cabinet, pas
pour un volume soutenu.

### Ce dont ces processus dépendent

| Service | Variables | Sans lui |
| --- | --- | --- |
| **Fournisseur d'identité** (OIDC) | `AUTH_MODE`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_WEB_CLIENT_ID`, `KEYCLOAK_WEB_CLIENT_SECRET`, `AUTH_SECRET` | l'API refuse de démarrer |
| **Stockage objet** (R2) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | les pièces vont sur un disque éphémère |
| **Messagerie** (SMTP) | `SMTP_*`, `MAIL_FROM_ADDRESS`, `MAIL_LEGAL_FOOTER` | aucune invitation, aucune relance ne part |
| **Extraction IA** | `ANTHROPIC_API_KEY`, `AI_MODEL` | fournisseur et montants **inventés** dans la file de validation |
| **Antivirus** (clamd) | `CLAMAV_HOST` | tout fichier téléversé est accepté sans analyse |
| **Rendu PDF** (Chromium) | `CHROMIUM_PATH` | aucun état financier, aucune facture, aucun bulletin ne se télécharge |
| **Canal WhatsApp** | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET` | les messages sortants sont avalés |
| **Ancrage externe** | voir `OPERATIONS.md` § Ancrage | la chaîne de hachage reste vérifiable, mais sans témoin extérieur |

Deux dépendances restent **volontairement vides** : l'encaissement mobile money
(`PAYMENT_PROVIDER`) et la facture certifiée (`CERTIFICATION_CONNECTOR`). Aucun
opérateur réel n'est implémenté, et le simulateur est refusé en production sans
échappatoire : il annoncerait des règlements qui n'ont pas eu lieu et imprimerait
des références fiscales inventées sur les factures de vos clients. Vide = la
fonction est **coupée proprement**, ce qui est la seule position tenable.

---

## 2. Ce qui casse sans chaque morceau

Ce tableau existe pour une raison : chacune de ces lignes a déjà été vue, dans
un produit ou un autre, découverte après la mise en ligne.

| Ce qui manque | Ce qui se passe | Quand on s'en aperçoit |
| --- | --- | --- |
| RLS non forcée sur une table | un dossier lit les données d'un autre | quand un client le signale — trop tard |
| `DATABASE_URL` sur le compte propriétaire | la RLS ne s'applique pas du tout au compte applicatif | jamais, sans contrôle explicite |
| Correspondant d'audience OIDC absent | connexion réussie, **401 partout ensuite** | à la première page de données |
| SMTP absent | l'expert-comptable invité ne reçoit pas son code à usage unique | quand il vous appelle |
| SPF/DKIM absents | les invitations partent en indésirables | jamais : personne ne signale ce qu'il n'a pas reçu |
| Chromium absent | tout téléchargement de PDF échoue | à la première liasse demandée |
| Stockage local sur Replit | les pièces disparaissent au redéploiement | après une mise à jour |
| `PAYROLL_ENCRYPTION_KEY` perdue | la paie déjà enregistrée devient **définitivement** indéchiffrable | quand on en a besoin |
| Migrations non jouées | l'API démarre, la première requête casse | à la première page |
| Second déploiement branché sur la même base | deux chaînes de hachage concurrentes sur le même journal | à l'audit |

---

## 3. Choisir la route

| | **Replit — Reserved VM** | **Serveur — Docker + Caddy** |
| --- | --- | --- |
| Mise en place | une heure | une demi-journée |
| Processus | **un seul**, deux applications dedans | quatre conteneurs + Caddy |
| Port public | **un seul** (le web) | autant que voulu |
| Webhooks entrants (WhatsApp, paiement) | **impossibles** : l'API n'a pas d'entrée publique | oui |
| Worker séparé | non : les tâches tournent dans l'API | oui |
| Redis | non | oui |
| Fichiers téléversés | perdus au redéploiement sans R2 | volume, ou R2 |
| Certificats | fournis | Let's Encrypt via Caddy |
| Sauvegarde de la base | selon le fournisseur | `scripts/backup.mts`, à vous |

**Recommandation.** Pour l'essai avec l'expert-comptable de Togo : **Replit**,
avec R2 branché dès le départ (sinon les pièces de l'essai disparaissent à la
première mise à jour). Pour la mise en service réelle : **le serveur**, parce
que les webhooks entrants et le worker séparé n'y sont pas optionnels.

Le dépôt sert les deux sans fork : `.replit` n'est lu que par Replit,
`docker-compose.prod.yml` que par le serveur.

---

## 4. L'ordre des opérations

L'ordre n'est pas indicatif. Chaque étape produit ce dont la suivante a besoin.

### 4.1 Avant de toucher à quoi que ce soit

Réunissez ce qu'aucun script ne peut fabriquer :

- le domaine (**arcompt.com**, chez GoDaddy) et l'accès à sa zone DNS ;
- la boîte d'envoi (**info@arcompt.com**, Zoho) et un **mot de passe
  d'application** — pas le mot de passe de la boîte ;
- un fournisseur d'identité OIDC joignable **depuis le serveur** ;
- un compte de stockage objet R2 et son bucket ;
- une clé Anthropic, si l'extraction des pièces doit être réelle ;
- l'endroit où vous conserverez `PAYROLL_ENCRYPTION_KEY` hors du serveur.

### 4.2 Les dix étapes

| # | Étape | Commande | Preuve que c'est fait |
| --- | --- | --- | --- |
| 1 | Créer la base | selon la route | `psql … -c 'select 1'` |
| 2 | Jouer les migrations, **sous le compte propriétaire** | `pnpm db:migrate` | « 16 migration(s) appliquée(s) » |
| 3 | Créer le rôle de connexion applicatif | `APP_DB_PASSWORD='…' pnpm exec tsx scripts/provision-app-role.mts` | « 30 contrôles has_table_privilege » |
| 4 | Basculer `DATABASE_URL` sur ce rôle | configuration | `pnpm preflight` → « ni superuser ni bypassrls » |
| 5 | Poser les secrets | § 5 ci-dessous | `pnpm preflight` → aucune ligne ✗ |
| 6 | Configurer le fournisseur d'identité, **correspondant d'audience compris** | console du fournisseur | § 7, parcours 1 |
| 7 | Éprouver la messagerie | `pnpm mail:check --to vous@exemple.com` | message reçu, `spf=pass` et `dkim=pass` dans l'en-tête |
| 8 | Publier | selon la route | le site répond |
| 9 | Brancher le domaine et les enregistrements DNS | GoDaddy | `pnpm preflight --url https://arcompt.com` |
| 10 | Créer le premier compte, puis faire le parcours | `pnpm exec tsx scripts/create-test-account.mts` | § 7 |

**Étape 2 et étape 3 ne se permutent pas.** Les migrations créent le rôle de
groupe `arcompt_app` et posent ses droits ; `provision-app-role` ne fait que lui
rattacher un rôle de connexion. Lancé avant, il refuse — avec un message clair,
mais il refuse.

**Étape 4 est celle qu'on saute.** Migrer puis laisser `DATABASE_URL` sur le
compte propriétaire donne une plateforme qui *fonctionne* et dont la RLS ne
protège rien : le propriétaire est `BYPASSRLS`. `pnpm preflight` a été écrit
d'abord pour attraper ce cas précis.

---

## 5. Le tableau complet des variables

Modèles prêts à remplir : [`.env.example`](../.env.example) (développement et
Replit), [`infra/env/prod.env.example`](../infra/env/prod.env.example) (serveur).

Fabriquer un secret : `openssl rand -base64 32`.

### 5.1 Sans quoi rien ne démarre

| Variable | Lue par | Valeur |
| --- | --- | --- |
| `NODE_ENV` | tout | `production` — c'est elle qui arme tous les refus |
| `DATABASE_URL` | API, worker | le rôle **applicatif**, jamais le propriétaire |
| `AUTH_MODE` | API, web | `oidc`. `dev` accepte un en-tête sans jeton |
| `KEYCLOAK_ISSUER` | API, web | l'URL du realm, au caractère près |
| `KEYCLOAK_CLIENT_ID` | API **et** web | ⚠ **deux valeurs différentes** — voir 5.2 |
| `KEYCLOAK_CLIENT_SECRET` | web | secret du client de connexion |
| `AUTH_SECRET` | web | 32 octets base64 |
| `PAYROLL_ENCRYPTION_KEY` | API | 32 octets base64 **exactement**. Perdue = paie illisible |
| `API_URL` | web | `http://127.0.0.1:4000` en un seul processus |
| `APP_URL` | API | l'URL publique, pour les liens dans les messages |

### 5.2 Le piège des deux clients OIDC

`KEYCLOAK_CLIENT_ID` est lue par l'API **et** par le web, et n'y a pas la même
valeur :

- le **web** s'y connecte : client confidentiel, code flow ;
- l'**API** n'accepte que les jetons dont l'**audience** est le client
  bearer-only.

Sur un serveur, ce sont deux conteneurs, donc deux environnements. Sur Replit,
c'est un seul processus parent : la variable est posée **par processus** dans la
commande de démarrage, depuis `KEYCLOAK_API_AUDIENCE` et
`KEYCLOAK_WEB_CLIENT_ID`. **Ne posez pas `KEYCLOAK_CLIENT_ID` dans les secrets
Replit** : l'une des deux applications s'en trouverait mal configurée.

Et dans les deux cas, le fournisseur doit porter un **correspondant d'audience**
sur le client web, qui ajoute l'audience de l'API dans le claim `aud`. Sans lui :
connexion réussie, 401 partout. `pnpm preflight` ne peut pas le vérifier — il le
dit, plutôt que de le supposer.

### 5.3 Dépendances : réelles, ou repli assumé

Chaque ligne se remplit, ou s'assume par l'opt-out.

| Fonction | Variables réelles | Opt-out | Ce que l'opt-out coûte |
| --- | --- | --- | --- |
| Extraction IA | `ANTHROPIC_API_KEY`, `AI_MODEL` | `ALLOW_INSECURE_AI` | fournisseur et montants inventés, validés en un tap |
| Stockage | `R2_*` (4) | `ALLOW_INSECURE_STORAGE` | pièces sur disque éphémère, conservation décennale perdue |
| Antivirus | `CLAMAV_HOST` | `ALLOW_INSECURE_ANTIVIRUS` | tout fichier accepté |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | `ALLOW_INSECURE_WHATSAPP` | messages sortants avalés |
| Messagerie | `SMTP_HOST`, `MAIL_FROM_ADDRESS` | `ALLOW_INSECURE_MAIL` | **aucune invitation ne part** |
| Pack pays non publié | — | `ALLOW_INSECURE_DRAFT_PACK_FILINGS` | documents produits marqués « DOCUMENT NON OFFICIEL » |

### 5.4 Doivent rester vides

| Variable | Pourquoi |
| --- | --- |
| `PAYMENT_PROVIDER` | `mock` annoncerait des règlements qui n'ont pas eu lieu — refusé sans échappatoire |
| `CERTIFICATION_CONNECTOR` | `mock` imprimerait une référence fiscale inventée sur les factures de vos clients |
| `KEYCLOAK_ADMIN_PASSWORD` | après la création d'un administrateur nominatif |

### 5.5 Ce qu'il est prudent d'ajouter

`SECURITY_ALERT_WEBHOOK_URL` (rafales d'échecs d'authentification, rejets RLS,
signatures de webhook invalides — sans lui ces signaux ne réveillent personne),
`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `MAIL_LEGAL_FOOTER` (mentions
légales en pied de chaque message ; vide, un texte de rappel part à la place,
visible du client), `DEFAULT_LOCALE`, `DEFAULT_CURRENCY`, `DEFAULT_COUNTRY_PACK`.

---

## 6. La preuve : `pnpm preflight`

Une commande éprouve l'ensemble, **avant** de publier :

```bash
pnpm preflight                            # environnement, base, identité, messagerie
pnpm preflight --mail                     # + la connexion SMTP réelle
pnpm preflight --url https://arcompt.com  # + le déploiement déjà en ligne
```

L'environnement est lu **comme s'il était en production** (`NODE_ENV=production`
est forcé pour la lecture, jamais écrit) : contrôler autre chose que ce qui sera
servi ne contrôlerait rien.

Le rapport distingue quatre états, et la distinction est le cœur du dispositif :

| | |
| --- | --- |
| **✗ BLOQUANT** | publier ainsi donne une plateforme cassée ou dangereuse. Code de sortie 1 |
| **⚠ DÉGRADÉ** | démarre, une fonction est coupée ou simulée. Acceptable pour un essai, jamais pour une comptabilité réelle |
| **✓ PROUVÉ** | vérifié à l'instant, pas supposé |
| **· NON VÉRIFIÉ** | demande un jeton réel, le compte propriétaire ou un message reçu. La ligne dit comment l'obtenir |

Ce qu'il éprouve vraiment, et que rien d'autre n'éprouvait :

- **l'isolation multi-dossiers, table par table** : toute table portant
  `tenant_id` dont la RLS n'est pas *activée et forcée* est nommée. C'est le
  contrôle le plus important du script, parce que c'est la panne qui ne se voit
  pas ;
- **le compte de connexion** : `superuser` ou `bypassrls` sur le compte
  applicatif fait échouer le contrôle — c'est l'étape 4 oubliée ;
- **les 30 contrôles de droits** du modèle `arcompt_app` ;
- **l'état des migrations**, quand le compte peut le lire — et quand il ne le
  peut pas, le script dit que c'est **le comportement voulu** du rôle restreint,
  plutôt que de compter cela comme une panne ;
- **la découverte OIDC** et les clés publiques, y compris la comparaison de
  l'émetteur annoncé avec `KEYCLOAK_ISSUER` (le `http://` posé là où le
  fournisseur sert en `https://` est la panne classique) ;
- **Chromium**, sans lequel aucun PDF ne sort ;
- en ligne : que le proxy **refuse** une requête anonyme. Un `200` sans session
  serait pire qu'une panne, et le script le traite comme tel.

Le code de sortie vaut 1 s'il reste un point bloquant : il est prévu pour être
la dernière commande d'un script de publication.

---

## 7. Le parcours humain, celui qu'aucun script ne remplace

Trois choses ne se prouvent qu'en les faisant. Faites-les dans cet ordre, avec
un vrai compte, sur le déploiement publié.

**Parcours 1 — la chaîne d'authentification tient.** Connectez-vous, ouvrez un
écran de données (le grand livre, par exemple). Une page qui s'affiche puis un
401 signifie que le correspondant d'audience manque. C'est l'étape qu'on oublie,
et elle ne se voit pas autrement.

**Parcours 2 — la comptabilité sort.** Créez un dossier, saisissez une écriture,
validez-la, ouvrez la balance, **téléchargez un état financier en PDF**. Le PDF
est le seul contrôle qui éprouve Chromium, le rendu, le stockage et les droits
d'un coup.

**Parcours 3 — le courrier arrive.** Invitez une adresse que vous relevez.
Ouvrez le message, **affichez l'en-tête complet**, exigez `spf=pass` **et**
`dkim=pass`. Sans les deux, les invitations de vos clients partiront en
indésirables, et personne ne signale ce qu'il n'a pas reçu.

Et, si vous éprouvez le mode hors ligne : coupez le réseau, saisissez une
facture, rétablissez le réseau, vérifiez qu'elle est partie **une seule fois**.
Ce que le mode hors ligne refuse de faire, et pourquoi, est dans
[`OFFLINE.md`](OFFLINE.md).

---

## 8. Conditions d'arrêt

Ne publiez pas, et ne confiez aucune comptabilité réelle, tant que l'un de ces
points tient :

1. `pnpm preflight` rend une ligne **✗**.
2. Le compte de `DATABASE_URL` est superuser ou `bypassrls`.
3. Une table portant `tenant_id` n'a pas la RLS forcée.
4. `PAYROLL_ENCRYPTION_KEY` n'existe qu'à un seul endroit — le serveur.
5. Le message de contrôle n'est pas arrivé, ou son en-tête ne porte pas
   `spf=pass` et `dkim=pass`.
6. Deux déploiements pointent la même base.
7. Un `ALLOW_INSECURE_*` est posé sans que vous sachiez dire, de mémoire, ce
   qu'il coupe.

Les points 2, 3, 6 et 7 ne se rattrapent pas après coup : quand on s'en aperçoit,
les données ont déjà circulé.

---

## 9. Le lendemain de la mise en ligne

Rien de ce qui suit n'est facultatif pour une comptabilité réelle ; tout est
outillé, et détaillé dans [`OPERATIONS.md`](OPERATIONS.md).

| Quand | Quoi | Commande |
| --- | --- | --- |
| chaque jour | sauvegarde chiffrée | `scripts/backup.mts` |
| chaque jour | ancrage externe de la piste d'audit | `scripts/anchor-daily.mts` |
| chaque trimestre | **exercice de restauration** — une sauvegarde non restaurée n'est pas une sauvegarde | `scripts/restore-drill.mts` |
| chaque trimestre | revue des accès et des journaux d'accès administrateur | `OPERATIONS.md` |
| chaque année | exercice de reconstruction des clés | `OPERATIONS.md` |
| à chaque mise à jour | `pnpm preflight` avant de publier | — |

---

## 10. Ce que ce dossier ne couvre pas

Dit ici pour que personne ne le découvre en production :

- **Aucun opérateur mobile money réel** n'est implémenté. La fonction est
  coupée, pas simulée.
- **Aucun connecteur de certification fiscale réel** (FNE, MECeF) n'est
  implémenté. Idem.
- **Les packs pays n'ont pas été relus par un expert du pays.** Celui de Togo
  est prévu. Tant qu'un pack n'est pas `PUBLISHED`, les déclarations produites
  portent « DOCUMENT NON OFFICIEL ».
- **Sur Replit, les webhooks entrants n'ont pas d'entrée publique** : un seul
  port est exposé, celui du web.
- **La haute disponibilité n'est pas traitée.** Un seul exemplaire de l'API
  tient une file en mémoire et un navigateur : le dupliquer casse les deux.

---

*ARCOMPT — une plateforme ARGILETTE.*
