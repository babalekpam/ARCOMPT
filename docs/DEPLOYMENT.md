# Mise en ligne d'ARCOMPT

Ce guide part d'un domaine acheté chez GoDaddy et d'aucun serveur, et s'arrête
quand un expert-comptable peut se connecter à `https://arcompt.votre-domaine.ci`
et saisir une écriture. Il est écrit pour quelqu'un qui n'a jamais déployé.

Prévoir **une heure et demie** la première fois, dont une bonne demi-heure
d'attente (propagation DNS, premier démarrage de Keycloak).

> **Ce qui est déployé ici est une première version de test.** La section
> [Ce qui n'est pas encore de la production](#ce-qui-nest-pas-encore-de-la-production)
> dit exactement ce qui manque avant d'y mettre la comptabilité réelle d'un client.

---

## Table des matières

1. [Ce que vous allez obtenir](#1-ce-que-vous-allez-obtenir)
2. [Choisir et commander le serveur](#2-choisir-et-commander-le-serveur)
3. [Préparer le serveur](#3-préparer-le-serveur)
4. [Brancher le domaine GoDaddy](#4-brancher-le-domaine-godaddy)
5. [Récupérer le projet et remplir les variables](#5-récupérer-le-projet-et-remplir-les-variables)
6. [Premier démarrage et certificats](#6-premier-démarrage-et-certificats)
7. [Les migrations de base de données](#7-les-migrations-de-base-de-données)
8. [Configurer Keycloak](#8-configurer-keycloak)
9. [Créer le premier compte](#9-créer-le-premier-compte)
10. [Vérifier que tout marche](#10-vérifier-que-tout-marche)
11. [Mettre à jour](#11-mettre-à-jour)
12. [Revenir en arrière](#12-revenir-en-arrière)
13. [Sauvegardes](#13-sauvegardes)
14. [Quand ça ne marche pas](#14-quand-ça-ne-marche-pas)
15. [Ce qui n'est pas encore de la production](#ce-qui-nest-pas-encore-de-la-production)

---

## 1. Ce que vous allez obtenir

Un seul serveur fait tourner sept conteneurs :

```
                     Internet
                        │ 80 / 443
                  ┌─────▼─────┐
                  │   Caddy   │  certificats TLS automatiques
                  └──┬───┬──┬─┘
       arcompt.…     │   │  │     auth.arcompt.…
                     │   │  └──────────────► keycloak  (identité)
                     │   └──api.arcompt.…──► api       (métier, webhooks)
                     └──────────────────────► web      (PWA Next.js)
                                                │
                            ┌───────────────────┼───────────┐
                            ▼                   ▼           ▼
                        postgres             redis       worker
                      (comptabilité)     (file d'attente) (tâches de fond)
```

Points à retenir :

- **Un seul service est exposé sur Internet** : Caddy. PostgreSQL, Redis, l'API
  et le web ne sont joignables que depuis l'intérieur de la pile. C'est la
  différence majeure avec `docker-compose.yml`, qui publie le port 5432 pour le
  confort du développement.
- **Le navigateur n'appelle jamais l'API directement.** Il parle au serveur Next,
  qui relaie par `/api/proxy/…` en ajoutant le jeton côté serveur. Le nom
  `api.…` n'existe que pour les webhooks entrants (WhatsApp, paiement).
- **Les migrations tournent avant l'application**, dans une tâche à part qui doit
  réussir pour que l'API démarre.
- **Deux comptes PostgreSQL distincts** : le propriétaire du schéma migre,
  l'application se connecte avec un rôle restreint soumis à la Row-Level
  Security.

---

## 2. Choisir et commander le serveur

### La taille

| | vCPU | RAM | Disque | Verdict |
|---|---|---|---|---|
| Trop petit | 1 | 2 Go | 20 Go | Keycloak seul mange presque tout ; le rendu PDF fait tomber la machine |
| **Minimum viable** | **2** | **4 Go** | **40 Go** | Suffit pour un expert-comptable qui teste |
| **Recommandé** | **4** | **8 Go** | **80 Go** | Confortable, PDF rapides, marge pour les sauvegardes |

Pourquoi 4 Go au minimum : Keycloak est une application Java qui réserve
facilement 700 Mo à 1 Go, PostgreSQL 500 Mo, l'API et le worker 300 Mo chacun,
Next environ 200 Mo — et le rendu d'un PDF lance un Chromium qui demande
plusieurs centaines de mégaoctets le temps du rendu.

**Ne construisez pas les images sur ce serveur.** Elles sont fabriquées par
GitHub Actions (`.github/workflows/release.yml`) et simplement téléchargées ici.
Compiler sur place demanderait bien plus de RAM.

### L'hébergeur et la région

N'importe quel fournisseur de serveur virtuel convient. Les plus simples et les
moins chers pour ce gabarit :

| Hébergeur | Offre indicative | Remarque |
|---|---|---|
| Hetzner | CX22 / CPX21 | Le meilleur rapport prix/puissance ; centres de données en Allemagne et en Finlande |
| Scaleway | DEV1-M / PRO2-XXS | Paris et Amsterdam ; facturation en euros |
| DigitalOcean | Basic 4 Go | Interface très simple ; Francfort ou Amsterdam |
| OVHcloud | VPS Comfort | Présence à Paris, facturation en Afrique de l'Ouest facile |

**Choisissez un centre de données européen** (Paris, Francfort, Amsterdam) : la
latence depuis Abidjan, Dakar ou Douala y est de l'ordre de 100 à 150 ms, contre
250 ms et plus depuis l'Amérique du Nord. Il n'existe pas encore d'offre grand
public équivalente en Afrique de l'Ouest chez ces hébergeurs.

**Système d'exploitation : Debian 12 ou Ubuntu 24.04 LTS.** Le reste de ce guide
suppose l'un des deux.

Demandez aussi une **adresse IPv4 fixe** (c'est le cas par défaut) et notez-la :
elle vous servira au chapitre DNS. On l'écrira `203.0.113.10` dans les exemples.

---

## 3. Préparer le serveur

### 3.1 Se connecter et créer un utilisateur

Connectez-vous en root avec la clé SSH fournie par l'hébergeur :

```bash
ssh root@203.0.113.10
```

Travailler en root en permanence est une mauvaise habitude ; créez un compte :

```bash
adduser arcompt                 # choisissez un mot de passe
usermod -aG sudo arcompt
rsync --archive --chown=arcompt:arcompt ~/.ssh /home/arcompt
```

Vérifiez dans **une seconde fenêtre de terminal** que `ssh arcompt@203.0.113.10`
fonctionne avant de fermer la première. Puis interdisez la connexion directe en
root et l'authentification par mot de passe :

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

### 3.2 Le pare-feu

Trois ports, pas un de plus :

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

PostgreSQL (5432) n'est **pas** ouvert, et ne doit jamais l'être :
`docker-compose.prod.yml` ne publie pas ce port.

### 3.3 Installer Docker

Le paquet `docker.io` des dépôts Debian est souvent trop ancien pour
`docker compose`. Utilisez le dépôt officiel :

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker arcompt
```

Déconnectez-vous et reconnectez-vous pour que l'appartenance au groupe prenne
effet, puis vérifiez :

```bash
docker --version          # 24 ou plus
docker compose version    # v2.24 ou plus (v2 : « compose », sans tiret)
docker run --rm hello-world
```

### 3.4 Un peu de mémoire virtuelle

Sur une machine à 4 Go, un fichier d'échange évite qu'un pic de rendu PDF ne
tue un conteneur :

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 4. Brancher le domaine GoDaddy

À faire **avant** de démarrer la pile : Caddy demande les certificats dès son
premier démarrage, et Let's Encrypt vérifie que les noms pointent bien sur ce
serveur. Les enregistrements DNS mettent quelques minutes à se propager.

### 4.1 Les enregistrements à créer

Trois noms, trois enregistrements de type **A**, tous vers la même adresse IP.

**Cas A — le domaine entier est pour ARCOMPT** (`exemple.ci`,
`api.exemple.ci`, `auth.exemple.ci`) :

| Type | Nom (« Host ») | Valeur (« Points to ») | TTL |
|---|---|---|---|
| A | `@` | `203.0.113.10` | 600 secondes |
| A | `api` | `203.0.113.10` | 600 secondes |
| A | `auth` | `203.0.113.10` | 600 secondes |
| CNAME | `www` | `@` | 1 heure |

**Cas B — ARCOMPT vit sur un sous-domaine** d'un domaine déjà utilisé
(`arcompt.exemple.ci`, `api.arcompt.exemple.ci`, `auth.arcompt.exemple.ci`) :

| Type | Nom (« Host ») | Valeur | TTL |
|---|---|---|---|
| A | `arcompt` | `203.0.113.10` | 600 secondes |
| A | `api.arcompt` | `203.0.113.10` | 600 secondes |
| A | `auth.arcompt` | `203.0.113.10` | 600 secondes |

Le cas B est préférable si le domaine héberge déjà un site vitrine : rien
d'existant n'est touché.

### 4.2 Où cliquer chez GoDaddy

1. Connectez-vous sur `godaddy.com`, puis **Mes produits**.
2. À la ligne de votre domaine, bouton **DNS** (ou **Gérer le DNS**).
3. Vous arrivez sur **Gestion des DNS** → section **Enregistrements**.
4. Pour chaque ligne du tableau ci-dessus : **Ajouter un enregistrement**, type
   `A`, remplir *Nom* et *Valeur*, TTL **Personnalisé → 600 secondes**,
   **Enregistrer**.

Quatre pièges propres à GoDaddy :

- **Un enregistrement `A` sur `@` existe déjà** : il pointe vers la page de
  parking de GoDaddy. Il faut le **modifier** (icône crayon), pas en ajouter un
  second — deux enregistrements A sur le même nom enverraient la moitié des
  visiteurs chez GoDaddy.
- **Désactivez le « Transfert de domaine »** (*Forwarding*) s'il est actif. Il
  prend le pas sur vos enregistrements et renvoie les visiteurs ailleurs.
  Menu du domaine → **Transfert** → supprimer.
- **Les serveurs de noms doivent rester ceux de GoDaddy.** Si vous les avez
  changés un jour (pour Cloudflare par exemple), les enregistrements saisis ici
  ne servent à rien : il faut les créer chez l'autre fournisseur.
- **Pas de CNAME sur `@`.** C'est interdit par le protocole DNS, et GoDaddy le
  refusera. D'où l'enregistrement `A` sur l'apex.

### 4.3 Vérifier avant d'aller plus loin

Depuis votre poste (pas depuis le serveur) :

```bash
dig +short arcompt.exemple.ci
dig +short api.arcompt.exemple.ci
dig +short auth.arcompt.exemple.ci
```

Les trois doivent répondre `203.0.113.10`, et **rien d'autre**. Sous Windows :
`nslookup arcompt.exemple.ci`.

Tant qu'une des trois commandes ne répond pas, attendez. Comptez 5 à 30 minutes ;
si rien ne bouge au bout d'une heure, relisez les quatre pièges ci-dessus. Passer
à la suite trop tôt fait consommer inutilement le quota de Let's Encrypt
(5 échecs par heure et par domaine).

---

## 5. Récupérer le projet et remplir les variables

### 5.1 Le dépôt

Le serveur n'a besoin que des fichiers de configuration (compose, Caddyfile,
scripts d'initialisation) ; le code, lui, vit dans les images.

```bash
sudo apt install -y git
git clone https://github.com/<organisation>/ARCOMPT.git
cd ARCOMPT
```

### 5.2 Accéder aux images

Les images sont publiées sur GHCR par `.github/workflows/release.yml`. Si le
dépôt est privé, il faut s'authentifier une fois sur le serveur avec un jeton
GitHub ayant la portée `read:packages` :

```bash
echo '<jeton>' | docker login ghcr.io -u <votre-compte-github> --password-stdin
```

### 5.3 Le fichier de variables

```bash
cp infra/env/prod.env.example infra/env/prod.env
chmod 600 infra/env/prod.env
nano infra/env/prod.env
```

Fabriquez chaque secret avec `openssl rand -base64 32` — un par variable, jamais
le même deux fois, jamais un mot choisi à la main.

> **L'API relit toute cette configuration au démarrage et refuse de démarrer si
> quelque chose manque** (`apps/api/src/config.ts`). Elle ne s'arrête pas à la
> première erreur : elle les liste toutes d'un coup, avec pour chacune la
> conséquence concrète. C'est voulu — on ne corrige pas une variable par
> redéploiement.

#### Les variables obligatoires

| Variable | Ce que c'est | Comment l'obtenir |
|---|---|---|
| `WEB_DOMAIN` | Nom public de l'application | Chapitre 4 |
| `API_DOMAIN` | Nom public de l'API (webhooks) | Chapitre 4 |
| `AUTH_DOMAIN` | Nom public de Keycloak | Chapitre 4 |
| `ACME_EMAIL` | Adresse prévenue si un certificat ne se renouvelle pas | La vôtre |
| `API_IMAGE`, `WEB_IMAGE` | Images à déployer, **avec une version précise** | Onglet *Packages* du dépôt GitHub |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Propriétaire du schéma — **migrations uniquement** | `openssl rand -base64 32` |
| `APP_DB_USER` / `APP_DB_PASSWORD` | Rôle de connexion de l'application | `openssl rand -base64 32` ; 16 caractères minimum |
| `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` | Compte d'amorçage de la console Keycloak | À usage unique (chapitre 8) |
| `KEYCLOAK_WEB_CLIENT_ID` / `KEYCLOAK_WEB_CLIENT_SECRET` | Client de connexion du web | Créés au chapitre 8 |
| `KEYCLOAK_API_AUDIENCE` | Audience exigée dans les jetons par l'API | Créé au chapitre 8 |
| `AUTH_SECRET` | Chiffrement des cookies de session Auth.js | `openssl rand -base64 32` |
| `PAYROLL_ENCRYPTION_KEY` | Clé maître de chiffrement de la paie | `openssl rand -base64 32` — **base64 de 32 octets exactement** |
| `WHATSAPP_APP_SECRET` | Signature HMAC des webhooks Meta | `openssl rand -base64 32` |

Deux avertissements sur ce tableau :

- **`WHATSAPP_APP_SECRET` est exigée même si vous n'utilisez pas WhatsApp.**
  Il n'existe aucun `ALLOW_INSECURE_*` pour elle. Sans elle, l'API ne démarre
  pas. Si le canal n'est pas branché, une valeur aléatoire fait l'affaire.
- **`PAYROLL_ENCRYPTION_KEY` ne se change pas.** Elle déchiffre les données de
  paie déjà enregistrées ; la perdre les rend définitivement illisibles.
  Conservez-en une copie ailleurs que sur ce serveur, comme un code bancaire.

#### Les dépendances externes : réelles, ou repli assumé

Cinq fonctions dépendent de services extérieurs. Pour chacune, soit vous donnez
les vraies coordonnées, soit vous **acceptez explicitement** le repli avec un
`ALLOW_INSECURE_*`. Un oubli ne passe jamais en silence.

| Fonction | Variables réelles | Repli | Ce que le repli fait vraiment |
|---|---|---|---|
| Extraction IA des pièces | `ANTHROPIC_API_KEY` | `ALLOW_INSECURE_AI=1` | Fournisseur et montants **inventés** entrent dans la file de validation |
| Stockage des pièces | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | `ALLOW_INSECURE_STORAGE=1` | Les pièces vont sur un volume Docker local, non sauvegardé |
| Antivirus | `CLAMAV_HOST` | `ALLOW_INSECURE_ANTIVIRUS=1` | Tout fichier téléversé est accepté sans analyse |
| WhatsApp sortant | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | `ALLOW_INSECURE_WHATSAPP=1` | Les messages sortants sont avalés sans être envoyés |
| Encaissement mobile money | *(aucun opérateur réel implémenté)* | **aucun** | Laissez `PAYMENT_PROVIDER` **vide** : la fonction est proprement désactivée. La valeur `mock` est refusée en production, sans échappatoire |

De même, laissez `CERTIFICATION_CONNECTOR` **vide**. La valeur `mock`
imprimerait une référence fiscale et un QR code inventés sur les factures de vos
clients ; l'API refuse de démarrer avec.

Pour une première mise en ligne destinée à faire tester l'outil, les quatre
`ALLOW_INSECURE_*` sont acceptables — le modèle de l'exemple les pose déjà.
Relisez-les avant d'y mettre une comptabilité réelle :

```bash
grep -n 'ALLOW_INSECURE_' infra/env/prod.env
```

---

## 6. Premier démarrage et certificats

La ligne de commande est toujours la même ; on l'abrège :

```bash
alias arc='docker compose --env-file infra/env/prod.env -f docker-compose.prod.yml'
```

(Ajoutez-la à `~/.bashrc` pour la retrouver à la prochaine session.)

Vérifiez d'abord que la configuration se lit sans erreur — cette commande ne
démarre rien :

```bash
arc config -q
```

Si une variable obligatoire manque, elle vous le dit par son nom. Puis :

```bash
arc pull        # télécharge les images
arc up -d       # démarre tout
arc ps          # état des conteneurs
```

Le premier démarrage prend **deux à trois minutes** : Keycloak crée son schéma,
et Caddy demande trois certificats à Let's Encrypt.

Suivez l'obtention des certificats :

```bash
arc logs -f caddy
```

Vous cherchez trois lignes `certificate obtained successfully`. Si vous voyez
plutôt des erreurs ACME, c'est presque toujours le DNS : revenez au § 4.3.

Quand `arc ps` montre `api` et `web` en `healthy`, ouvrez
`https://arcompt.exemple.ci` : la page de connexion doit s'afficher avec un
cadenas valide.

---

## 7. Les migrations de base de données

**Elles sont automatiques.** Le service `migrate` de `docker-compose.prod.yml`
s'exécute avant l'API, et l'API ne démarre que si cette tâche s'est terminée
avec succès (`condition: service_completed_successfully`). Chaque `arc up -d`
rejoue cette tâche ; les migrations déjà appliquées sont ignorées.

La tâche fait deux choses, dans cet ordre :

1. **`node ops/migrate.mjs`** applique les fichiers manquants de
   `packages/db/migrations/`, chacun dans sa transaction, **sous un verrou
   consultatif PostgreSQL**. Deux déploiements lancés en même temps ne peuvent
   donc pas rejouer la même migration : le second attend, en le disant, jusqu'à
   `MIGRATION_LOCK_TIMEOUT` secondes (300 par défaut).
2. **`node ops/provision-role.mjs`** crée — ou met à jour — le rôle de connexion
   `arcompt_app_login`, membre du groupe `arcompt_app`, puis **vérifie le modèle
   de droits obtenu** : que l'application peut bien faire ce dont elle a besoin,
   et surtout qu'elle ne peut pas supprimer une clé de paie, réécrire la piste
   d'audit ni toucher à l'historique des migrations. Si un seul contrôle échoue,
   la tâche s'arrête en échec et l'API ne démarre pas.

Voir le déroulé :

```bash
arc logs migrate
```

La rejouer à la main (par exemple après avoir changé `APP_DB_PASSWORD`) :

```bash
arc run --rm migrate
```

> **Les migrations ne vont que dans un sens.** Il n'existe aucun script de retour
> arrière. C'est pourquoi le chapitre 12 commence par une sauvegarde.

---

## 8. Configurer Keycloak

Le fichier `infra/keycloak/realm-arcompt.json` est un realm **de développement** :
secrets factices, mots de passe en clair, URL en `http://localhost`. Il ne doit
pas être importé en production. On crée le realm à la main, une fois.

### 8.1 Un administrateur nominatif

Ouvrez `https://auth.arcompt.exemple.ci` et connectez-vous avec
`KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`.

Créez tout de suite un administrateur à votre nom (realm `master` → *Users* →
*Add user*, puis onglet *Role mapping* → rôle `admin`). Reconnectez-vous avec
lui, supprimez le compte d'amorçage, et videz les deux lignes
`KEYCLOAK_ADMIN*` dans `infra/env/prod.env`.

### 8.2 Le realm et les deux clients

1. Menu déroulant en haut à gauche → **Create realm** → nom : `arcompt`
   (la même valeur que `KEYCLOAK_REALM`).
2. **Clients → Create client** :
   - *Client ID* : `arcompt-api` (la valeur de `KEYCLOAK_API_AUDIENCE`)
   - *Client authentication* : **On**
   - *Standard flow*, *Direct access grants* : **décochés** — ce client ne sert
     qu'à nommer l'audience, personne ne s'y connecte.
3. **Clients → Create client** :
   - *Client ID* : `arcompt-web` (la valeur de `KEYCLOAK_WEB_CLIENT_ID`)
   - *Client authentication* : **On**
   - *Standard flow* : **coché**
   - *Valid redirect URIs* : `https://arcompt.exemple.ci/api/auth/callback/keycloak`
   - *Valid post logout redirect URIs* : `https://arcompt.exemple.ci/*`
   - *Web origins* : `https://arcompt.exemple.ci`
   - Onglet **Credentials** → copiez le *Client secret* dans
     `KEYCLOAK_WEB_CLIENT_SECRET`.

### 8.3 Le correspondant d'audience — l'étape qu'on oublie

L'API n'accepte un jeton que si son claim `aud` contient `arcompt-api`
(`apps/api/src/auth.ts`). Or un jeton émis pour `arcompt-web` ne le contient pas
spontanément. **Sans cette étape, tout renvoie 401, sans message utile.**

Dans le client `arcompt-web` : onglet **Client scopes** → `arcompt-web-dedicated`
→ **Add mapper** → **By configuration** → **Audience** :

- *Name* : `arcompt-api-audience`
- *Included Client Audience* : `arcompt-api`
- *Add to access token* : **On**

### 8.4 Appliquer les changements

`KEYCLOAK_WEB_CLIENT_SECRET` a changé, il faut le transmettre au conteneur web :

```bash
nano infra/env/prod.env      # coller le secret
arc up -d web
```

---

## 9. Créer le premier compte

Un compte utilisable, c'est **deux choses** : une identité dans Keycloak (qui
authentifie) et un `app_user` dans ARCOMPT rattaché à une organisation et à un
dossier (qui autorise). Les deux se rejoignent automatiquement à la première
connexion, **si l'adresse de courriel est la même des deux côtés et qu'elle est
vérifiée dans Keycloak**.

### 9.1 Créer le cabinet de démonstration dans ARCOMPT

Le seed crée une organisation de type cabinet, trois dossiers avec leur plan de
comptes SYSCOHADA, des écritures d'exemple, et trois utilisateurs
(`OWNER`, `ACCOUNTANT`, `REVIEWER`) :

```bash
arc run --rm -e SEED_FIRM=1 migrate node packages/db/src/seed.js
```

Il crée notamment `dirigeant@cabinet-demo.local` (rôle `OWNER`). Remplacez cette
adresse par celle, réelle, de l'expert-comptable qui va tester :

```bash
arc exec postgres psql -U arcompt -d arcompt -c \
  "UPDATE app_user SET email = 'expert@cabinet-reel.ci' WHERE email = 'dirigeant@cabinet-demo.local'"
```

### 9.2 Créer l'utilisateur dans Keycloak

Realm `arcompt` → **Users** → **Add user** :

- *Email* : exactement `expert@cabinet-reel.ci`
- *Email verified* : **On** — sans cela, le rattachement automatique est refusé,
  délibérément (sinon s'inscrire avec l'adresse d'autrui suffirait à prendre son
  dossier).
- *Username* : la même adresse fait très bien l'affaire.

Onglet **Credentials** → *Set password* → décochez *Temporary* si vous voulez
éviter le changement forcé au premier accès.

### 9.3 Le second facteur

Le seed crée l'organisation cabinet avec `mfa_required = true`, et **l'API
applique ce drapeau** : elle refuse en 403 tout jeton qui ne prouve pas un second
facteur (claim `amr` contenant `mfa`/`otp`/`hwk`/`swk`, ou `acr` ≥ 2).

Deux chemins, au choix :

- **Le faire correctement** : enrôler l'utilisateur en TOTP (action requise
  *Configure OTP*) et déclarer la correspondance ACR dans le realm
  (*Realm settings → Sessions → ACR to LoA mapping*, par exemple `{"otp": 2}`)
  avec une condition *Level of Authentication* dans le flux navigateur.
  Détails dans `infra/keycloak/README.md`.
- **Le désactiver le temps du test** :

  ```bash
  arc exec postgres psql -U arcompt -d arcompt -c \
    "UPDATE organization SET mfa_required = false WHERE kind = 'FIRM'"
  ```

  À remettre à `true` avant toute utilisation réelle.

### 9.4 Se connecter

`https://arcompt.exemple.ci` → *Se connecter* → redirection vers Keycloak →
retour sur le tableau de bord. Le rattachement `app_user.keycloak_sub` s'est fait
tout seul.

Si ce n'est pas le cas, le rattachement manuel est décrit dans
`infra/keycloak/README.md`.

---

## 10. Vérifier que tout marche

```bash
arc ps                                          # tout en « running », api et web en « healthy »
curl -sS https://api.arcompt.exemple.ci/health  # {"ok":true,"service":"arcompt-api"}
curl -sSo /dev/null -w '%{http_code}\n' https://api.arcompt.exemple.ci/health/ready   # 200
curl -sSo /dev/null -w '%{http_code}\n' https://arcompt.exemple.ci                    # 200 ou 307
```

Les deux sondes de l'API ne disent pas la même chose : `/health` répond tant que
le processus vit (« faut-il redémarrer ce conteneur ? »), `/health/ready` fait un
aller-retour réel vers PostgreSQL (« cette instance peut-elle servir ? »).

Puis, dans le navigateur, le parcours qui prouve que la chaîne complète tient :

1. se connecter ;
2. ouvrir un dossier, aller au grand livre ;
3. saisir une écriture équilibrée et la valider ;
4. **essayer d'en saisir une déséquilibrée** : elle doit être refusée par la base,
   pas seulement par l'écran ;
5. ouvrir les états financiers et **télécharger un PDF** — c'est le seul test qui
   exerce Chromium dans le conteneur API.

---

## 11. Mettre à jour

Les images sont construites et publiées par GitHub Actions à chaque poussée sur
la branche de travail et à chaque étiquette `v*`. Le déploiement, lui, reste une
action délibérée :

```bash
cd ~/ARCOMPT
git pull                                # au cas où compose ou le Caddyfile ont changé
nano infra/env/prod.env                 # API_IMAGE et WEB_IMAGE sur la nouvelle version
arc pull
arc up -d
arc ps
```

`arc up -d` relance la tâche de migration avant de remplacer l'API : si une
migration échoue, l'ancienne API continue de tourner.

**Épinglez toujours une version précise** (`:v0.2.0` ou `:sha-…`), jamais
`:latest`. Sans cela, on ne sait plus ce qui tourne, et le retour arrière du
chapitre suivant devient impossible.

---

## 12. Revenir en arrière

### 12.1 Avant toute mise à jour : la sauvegarde

Les migrations ne se rejouent que vers l'avant. Revenir à une image antérieure
**ne défait pas** un changement de schéma. La seule sortie de secours est une
sauvegarde prise juste avant :

```bash
arc exec -T postgres pg_dump -U arcompt -Fc arcompt > ~/arcompt-avant-v0.2.0.dump
```

### 12.2 Revenir à la version précédente de l'application

Si le schéma n'a pas changé entre les deux versions (aucun nouveau fichier dans
`packages/db/migrations/`), il suffit de reposer les anciennes images :

```bash
nano infra/env/prod.env      # API_IMAGE et WEB_IMAGE sur l'ancienne version
arc pull
arc up -d
```

### 12.3 Revenir aussi sur les données

Si la nouvelle version a migré le schéma et qu'il faut vraiment tout défaire :

```bash
arc stop api web worker            # plus personne n'écrit
arc exec -T postgres dropdb -U arcompt arcompt
arc exec -T postgres createdb -U arcompt arcompt
arc exec -T postgres pg_restore -U arcompt -d arcompt < ~/arcompt-avant-v0.2.0.dump
nano infra/env/prod.env            # images précédentes
arc up -d
```

**Tout ce qui a été saisi depuis la sauvegarde est perdu.** C'est la raison pour
laquelle on sauvegarde juste avant de déployer, et pas la veille.

---

## 13. Sauvegardes

Trois choses à sauvegarder, par ordre d'importance :

1. **Le volume `pgdata`** — toute la comptabilité. Un `pg_dump` quotidien, copié
   **hors du serveur**.
2. **`infra/env/prod.env`** — en particulier `PAYROLL_ENCRYPTION_KEY`, sans
   laquelle les données de paie déjà enregistrées sont définitivement illisibles.
   À conserver dans un gestionnaire de mots de passe, pas dans le dépôt.
3. **Le volume `caddy_data`** — les certificats. Sans lui, Caddy les redemande,
   ce qui est sans conséquence sauf si vous redémarrez souvent (Let's Encrypt
   limite à 5 émissions par semaine et par nom).

Une sauvegarde quotidienne, gardée 14 jours :

```bash
mkdir -p ~/sauvegardes
cat > ~/sauvegarde-arcompt.sh <<'EOF'
#!/bin/sh
set -eu
cd "$HOME/ARCOMPT"
horodatage=$(date +%Y%m%d-%H%M)
docker compose --env-file infra/env/prod.env -f docker-compose.prod.yml \
  exec -T postgres pg_dump -U arcompt -Fc arcompt > "$HOME/sauvegardes/arcompt-$horodatage.dump"
find "$HOME/sauvegardes" -name 'arcompt-*.dump' -mtime +14 -delete
EOF
chmod +x ~/sauvegarde-arcompt.sh
(crontab -l 2>/dev/null; echo '15 2 * * * $HOME/sauvegarde-arcompt.sh') | crontab -
```

Une sauvegarde qui n'a jamais été restaurée n'est pas une sauvegarde :
essayez `pg_restore` sur une base jetable au moins une fois.

---

## 14. Quand ça ne marche pas

**Le premier réflexe, toujours :**

```bash
arc ps          # qui est tombé, qui est « unhealthy »
arc logs --tail=100 api
```

### « Le site est inaccessible » / le certificat est invalide

```bash
arc logs --tail=50 caddy
dig +short arcompt.exemple.ci        # doit rendre l'IP du serveur, et elle seule
sudo ufw status                      # 80 et 443 ouverts
```

Presque toujours du DNS : enregistrement `A` de parking GoDaddy resté en place,
*Forwarding* actif, ou serveurs de noms délégués ailleurs (§ 4.2).

### Le conteneur `api` redémarre en boucle

```bash
arc logs api | head -40
```

Cherchez `Configuration de production invalide` : l'API liste **tous** les
problèmes d'un coup, avec la conséquence de chacun. Les oublis les plus
fréquents :

| Message | Cause |
|---|---|
| `WHATSAPP_APP_SECRET : absent` | Exigée même sans WhatsApp, sans opt-out |
| `PAYROLL_ENCRYPTION_KEY : base64 de 32 octets attendu` | Une clé tronquée, ou autre chose que `openssl rand -base64 32` |
| `AUTH_MODE : doit valoir « oidc »` | Variable écrasée quelque part ; `docker-compose.prod.yml` la fixe |
| `PAYMENT_PROVIDER : vaut « mock »` | Laissez la variable vide |
| `CERTIFICATION_CONNECTOR : vaut « mock »` | Laissez la variable vide |

### `migrate` en échec, `api` ne démarre jamais

```bash
arc logs migrate
```

- `verrou non obtenu après 300 s` : une autre migration tourne, ou un conteneur
  de migration a été tué en gardant le verrou. Vérifiez qu'aucune tâche
  `migrate` ne subsiste (`arc ps -a`), puis relancez `arc run --rm migrate`.
- `Rôle arcompt_app absent` : les migrations n'ont pas été appliquées ; regardez
  l'erreur au-dessus.
- `Mot de passe trop court` : `APP_DB_PASSWORD` fait moins de 16 caractères.
- `le modèle de droits n'est pas respecté` : chaque ligne nomme la table, le
  droit et la raison. C'est un refus délibéré — ne le contournez pas, corrigez.

### Tout renvoie 401 après la connexion

Dans l'ordre de probabilité :

1. **Le correspondant d'audience manque** (§ 8.3). C'est la cause n° 1.
2. `KEYCLOAK_ISSUER` ne correspond pas **exactement** à l'émetteur du jeton —
   `https://auth.…/realms/arcompt`, sans barre oblique finale, en `https`.
3. L'horloge du serveur dérive : `timedatectl status` doit indiquer
   `System clock synchronized: yes`. Un décalage de quelques minutes suffit à
   faire rejeter tous les jetons.

Pour trancher : copiez le jeton d'accès depuis les outils de développement du
navigateur et décodez son deuxième segment (`aud`, `iss`, `exp`).

### Connexion acceptée, mais 403 partout

- **Second facteur manquant** alors que l'organisation l'exige (§ 9.3) : le jeton
  doit porter `amr` ou `acr` ≥ 2.
- **Rattachement non fait** : l'adresse diffère entre Keycloak et `app_user`, ou
  n'est pas vérifiée dans Keycloak.

```bash
arc exec postgres psql -U arcompt -d arcompt -c \
  "SELECT email, keycloak_sub IS NOT NULL AS rattache, suspended_at FROM app_user"
```

- **Aucune appartenance** : l'utilisateur existe mais n'est membre d'aucun
  dossier (`company_member`).

### Keycloak boucle sur `http://` ou refuse la redirection

`KC_PROXY_HEADERS=xforwarded` et `KC_HOSTNAME` sont déjà posés par
`docker-compose.prod.yml`. Vérifiez que `AUTH_DOMAIN` est bien le nom public et
que l'URI de redirection du client `arcompt-web` est en `https`.

### Le téléchargement d'un PDF échoue

Seul le rendu PDF utilise Chromium. Le message `Chromium introuvable` signifie
que l'image a été modifiée ; une erreur de mémoire signifie que la machine est
trop petite (§ 2) — ajoutez le fichier d'échange du § 3.4.

### Plus de place sur le disque

```bash
df -h
docker system df
docker system prune -a --volumes=false   # ne touche PAS aux volumes de données
```

`--volumes=false` est important : il protège `pgdata`.

### Repartir de zéro

```bash
arc down            # arrête tout, GARDE les données
arc down -v         # DÉTRUIT AUSSI la base et les certificats — irréversible
```

---

## Ce qui n'est pas encore de la production

À lire avant d'y mettre la comptabilité réelle d'un client.

| Sujet | État | Conséquence |
|---|---|---|
| Stockage des pièces | Volume Docker local si R2 n'est pas configuré | La conservation décennale AUDCIF demande un stockage objet sauvegardé |
| Antivirus | Absent si `CLAMAV_HOST` n'est pas renseigné | Tout fichier téléversé est accepté sans analyse |
| Extraction IA | Simulée sans `ANTHROPIC_API_KEY` | Fournisseur et montants inventés dans la file de validation |
| Encaissement mobile money | Aucun opérateur réel implémenté | Fonction désactivée ; les liens de paiement ne sont pas montés |
| Facture certifiée (FNE/MECeF) | Aucun connecteur réel | Pas de certification fiscale sur les factures |
| Haute disponibilité | Une seule machine, un seul exemplaire de chaque service | Toute mise à jour coupe le service quelques secondes ; une panne du serveur coupe tout |
| Sauvegardes hors site | À mettre en place (§ 13) | Un disque perdu = la comptabilité perdue |
| Surveillance | `SENTRY_DSN` et `SECURITY_ALERT_WEBHOOK_URL` vides | Les alertes de sécurité restent dans les journaux et ne réveillent personne |

Voir aussi `docs/SECURITY.md` et `docs/OPERATIONS.md`.
