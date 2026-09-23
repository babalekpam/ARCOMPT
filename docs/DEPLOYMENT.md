# Mise en ligne d'ARCOMPT

Le dossier d'ensemble — inventaire des composants, ordre des opérations,
tableau complet des variables et contrôle automatique — est
[`DEPLOYMENT-PACKAGE.md`](DEPLOYMENT-PACKAGE.md). Ce guide-ci en est la route
serveur, détaillée commande par commande.

Ce guide part du domaine **`arcompt.com`** (enregistré chez GoDaddy) et d'aucun
serveur, et s'arrête quand un expert-comptable peut se connecter à
`https://arcompt.com` et saisir une écriture. Il est écrit pour quelqu'un qui
n'a jamais déployé.

Prévoir **une heure et demie** la première fois, dont une bonne demi-heure
d'attente (propagation DNS, premier démarrage de Keycloak).

Les quatre noms utilisés dans tout ce document :

| Nom | Sert à |
|---|---|
| `arcompt.com` | L'application (nom canonique) |
| `www.arcompt.com` | Redirection permanente vers `arcompt.com` |
| `api.arcompt.com` | L'API — uniquement pour les webhooks entrants |
| `auth.arcompt.com` | Keycloak, le fournisseur d'identité |

L'adresse IP du serveur est notée `203.0.113.10` dans les exemples : remplacez-la
partout par celle que votre hébergeur vous donnera.

> **Il existe une seconde route, sans serveur ni conteneurs :**
> [`docs/DEPLOYMENT-REPLIT.md`](DEPLOYMENT-REPLIT.md) déploie la même
> application sur Replit. Plus rapide à mettre en place, mais Keycloak n'y
> tourne pas (il faut un fournisseur d'identité hébergé) et le stockage des
> pièces y exige un stockage objet externe. Ce document-ci reste la route de
> référence.

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
       arcompt.com     │   │  │   auth.arcompt.com
                       │   │  └────────────────► keycloak  (identité)
                       │   └── api.arcompt.com ► api       (métier, webhooks)
                       └───────────────────────► web       (PWA Next.js)
                                                   │
                              ┌────────────────────┼────────────┐
                              ▼                    ▼            ▼
                          postgres              redis        worker
                        (comptabilité)     (file d'attente)  (tâches de fond)
```

Points à retenir :

- **Un seul service est exposé sur Internet** : Caddy. PostgreSQL, Redis, l'API
  et le web ne sont joignables que depuis l'intérieur de la pile. C'est la
  différence majeure avec `docker-compose.yml`, qui publie le port 5432 pour le
  confort du développement.
- **Le navigateur n'appelle jamais l'API directement.** Il parle au serveur Next,
  qui relaie par `/api/proxy/…` en ajoutant le jeton côté serveur. Le nom
  `api.arcompt.com` n'existe que pour les webhooks entrants (WhatsApp, paiement).
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
| OVHcloud | VPS Comfort | Présence à Paris, paiement depuis l'Afrique de l'Ouest facile |

**Choisissez un centre de données européen** (Paris, Francfort, Amsterdam) : la
latence depuis Abidjan, Dakar, Lomé ou Douala y est de l'ordre de 100 à 150 ms,
contre 250 ms et plus depuis l'Amérique du Nord. Il n'existe pas encore d'offre
grand public équivalente en Afrique de l'Ouest chez ces hébergeurs.

**Système d'exploitation : Debian 12 ou Ubuntu 24.04 LTS.** Le reste de ce guide
suppose l'un des deux.

Demandez aussi une **adresse IPv4 fixe** (c'est le cas par défaut) et notez-la :
elle vous servira au chapitre DNS.

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

**À faire avant de démarrer la pile.** Caddy demande les certificats dès son
premier démarrage : si les noms ne résolvent pas encore, la demande échoue.

### 4.1 Les enregistrements à créer

Quatre noms. Trois enregistrements **A** vers l'adresse IP du serveur, et un
**CNAME** pour `www`.

| Type | Nom (« Host ») | Valeur (« Points to ») | TTL |
|---|---|---|---|
| **A** | `@` | `203.0.113.10` | 600 secondes |
| **A** | `api` | `203.0.113.10` | 600 secondes |
| **A** | `auth` | `203.0.113.10` | 600 secondes |
| **CNAME** | `www` | `@` | 1 heure |

Lecture de ce tableau : chez GoDaddy, le champ *Nom* ne contient que la partie
gauche. `@` désigne le domaine nu, `arcompt.com`. Écrire `api` produit
`api.arcompt.com` — **n'écrivez pas `api.arcompt.com` dans ce champ**, vous
obtiendriez `api.arcompt.com.arcompt.com`.

### 4.2 `www` : CNAME ou A ?

**Un CNAME vers `@`**, c'est la bonne réponse ici.

Le Caddyfile (`infra/caddy/Caddyfile`) déclare `www.arcompt.com` comme un site à
part entière qui **redirige en 301 vers `https://arcompt.com`**. L'application
n'est servie que sous un seul nom : les URI de redirection de Keycloak et le
cookie de session Auth.js sont attachés à un hôte précis, et se connecter sur
`www` pour naviguer ensuite sur le domaine nu déconnecterait l'utilisateur.

Conséquences pratiques :

- `www.arcompt.com` doit **résoudre vers le serveur** — Caddy demande un
  certificat pour ce nom aussi, afin que la redirection se fasse en HTTPS et non
  sur un avertissement de sécurité.
- Un CNAME vers `@` suffit et se comporte exactement comme un A : la résolution
  suit la chaîne jusqu'à l'adresse du serveur, ce que la validation Let's Encrypt
  accepte sans réserve.
- L'avantage du CNAME est qu'il n'y a **qu'un seul endroit à modifier** le jour
  où le serveur change d'adresse : l'enregistrement `@`.
- Un enregistrement A sur `www` marcherait tout aussi bien ; il faudrait
  simplement penser à le changer lui aussi lors d'un déménagement.

`@` ne peut en revanche **pas** être un CNAME : le protocole DNS l'interdit à
l'apex d'un domaine, et GoDaddy refusera. D'où l'enregistrement A.

### 4.3 Où cliquer chez GoDaddy

1. Connectez-vous sur `godaddy.com`, puis **Mes produits**.
2. À la ligne `arcompt.com`, bouton **DNS** (ou **Gérer le DNS**).
3. Vous arrivez sur **Gestion des DNS** → section **Enregistrements**.
4. Pour chaque ligne du tableau : **Ajouter un enregistrement**, choisir le type,
   remplir *Nom* et *Valeur*, TTL **Personnalisé → 600 secondes**,
   **Enregistrer**.

Quatre pièges propres à GoDaddy :

- **Un enregistrement `A` sur `@` existe déjà** : il pointe vers la page de
  parking de GoDaddy. Il faut le **modifier** (icône crayon), pas en ajouter un
  second — deux enregistrements A sur le même nom enverraient la moitié des
  visiteurs chez GoDaddy.
- **Un CNAME `www` existe probablement déjà**, lui aussi vers le parking.
  Modifiez-le pour qu'il pointe sur `@`.
- **Désactivez le « Transfert de domaine »** (*Forwarding*) s'il est actif. Il
  prend le pas sur vos enregistrements et renvoie les visiteurs ailleurs.
  Menu du domaine → **Transfert** → supprimer.
- **Les serveurs de noms doivent rester ceux de GoDaddy.** Si vous les avez
  changés un jour (pour Cloudflare par exemple), les enregistrements saisis ici
  ne servent à rien : il faut les créer chez l'autre fournisseur. Et si vous
  passez un jour par Cloudflare, mettez les trois entrées en mode **DNS only**
  (nuage gris) : le mode mandataire casserait la validation de Caddy.

### 4.4 Vérifier avant d'aller plus loin

Depuis votre poste (pas depuis le serveur) :

```bash
dig +short arcompt.com
dig +short www.arcompt.com
dig +short api.arcompt.com
dig +short auth.arcompt.com
```

Les quatre doivent finir sur `203.0.113.10`, et **rien d'autre**
(`www.arcompt.com` affichera d'abord `arcompt.com.`, puis l'adresse : c'est
normal, c'est la chaîne du CNAME). Sous Windows : `nslookup arcompt.com`.

Tant qu'une des quatre commandes ne répond pas, **attendez**. Comptez 5 à
30 minutes ; si rien ne bouge au bout d'une heure, relisez les quatre pièges
ci-dessus.

### 4.5 Ce qu'il faut pour que les certificats soient délivrés

Caddy demande un certificat par nom à Let's Encrypt, qui vérifie que vous
contrôlez bien chacun d'eux en venant frapper à la porte du serveur. Cinq
conditions, toutes nécessaires :

1. **Les quatre noms résolvent vers l'IP publique du serveur**, et ce **avant**
   le premier `up`. C'est la condition qu'on oublie : un nom qui ne résout pas
   encore donne un échec de validation, pas une attente.
2. **Les ports 80 et 443 sont joignables depuis Internet.** Le port 80 sert au
   défi HTTP-01 ; le fermer « parce qu'on est en HTTPS » empêche toute émission.
   Vérifiez le pare-feu du serveur (§ 3.2) **et** celui de l'hébergeur (groupe
   de sécurité, *cloud firewall*), qui est un second filtre.
3. **Rien d'autre n'occupe ces ports** : ni Apache, ni Nginx installés par
   l'image système. `sudo ss -lntp | grep -E ':80|:443'` ne doit rien montrer
   avant le démarrage de Caddy.
4. **`ACME_EMAIL` est une adresse valide.** Let's Encrypt s'en sert pour vous
   prévenir si un renouvellement échoue.
5. **Le volume `caddy_data` est conservé.** C'est là que vivent les certificats
   et la clé de compte ACME. Le détruire force une réémission.

Sur les quotas : Let's Encrypt limite à **5 échecs de validation par heure** pour
un même nom, et à **50 certificats par semaine** pour un même domaine
enregistré. En pratique on ne les atteint qu'en relançant en boucle un
démarrage dont le DNS n'est pas prêt — d'où le § 4.4 avant celui-ci. En cas de
doute, essayez d'abord avec l'environnement de test de Let's Encrypt en
ajoutant `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` dans
le bloc global du Caddyfile : les certificats obtenus ne seront pas reconnus par
les navigateurs, mais les quotas y sont bien plus larges. Retirez cette ligne
une fois la chaîne validée.

Le renouvellement, ensuite, est automatique : Caddy s'en occupe environ 30 jours
avant l'expiration, sans intervention.

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
| `WEB_DOMAIN` | `arcompt.com` — nom canonique de l'application | Chapitre 4 |
| `API_DOMAIN` | `api.arcompt.com` | Chapitre 4 |
| `AUTH_DOMAIN` | `auth.arcompt.com` | Chapitre 4 |
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

#### Les variables facultatives qui comptent

| Variable | Défaut | Effet |
|---|---|---|
| `SHUTDOWN_GRACE_MS` | `10000` | Délai, en millisecondes, laissé par l'API aux requêtes en cours après un SIGTERM. Pendant ce temps `/health/ready` répond 503 pour sortir de rotation, tandis que `/health` reste vert |
| `STOP_GRACE_PERIOD` | `20s` | Patience de Docker avant SIGKILL. **Doit rester supérieure à `SHUTDOWN_GRACE_MS`**, sinon le processus est tué au milieu de son arrêt en douceur |
| `MIGRATION_LOCK_TIMEOUT` | `300` | Attente maximale, en secondes, du verrou de migration |
| `MAX_DOCUMENT_BYTES` | `15728640` | Taille maximale d'une pièce téléversée (15 Mio). La limite de Caddy, dans le Caddyfile, est à 20 Mo pour laisser de la marge à l'enveloppe multipart |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `SECURITY_ALERT_WEBHOOK_URL` | vides | Sans elles, il ne reste que les journaux structurés |

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

Une sixième variable de la même famille ne concerne pas un service extérieur
mais le pack pays du dossier :

| Fonction | Condition réelle | Échappement | Ce que l'échappement fait vraiment |
|---|---|---|---|
| Déclarations, liasse DSF, dépôts | Pack pays en `status: "PUBLISHED"` avec `reviewed_by` | `ALLOW_INSECURE_DRAFT_PACK_FILINGS=1` | Les documents sont produits depuis un pack non publié, **marqués « DOCUMENT NON OFFICIEL »** (bandeau sur chaque onglet du classeur, nom de fichier suffixé, `official = false` en base). Sans lui, ces opérations sont refusées ; la tenue, la facturation et les états financiers ne le sont jamais. Voir `docs/country-packs/README.md` |

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
et Caddy demande quatre certificats à Let's Encrypt.

Suivez l'obtention des certificats :

```bash
arc logs -f caddy
```

Vous cherchez quatre lignes `certificate obtained successfully`. Si vous voyez
plutôt des erreurs ACME, relisez le § 4.5 — c'est presque toujours le DNS ou le
port 80.

Quand `arc ps` montre `api` et `web` en `healthy`, ouvrez `https://arcompt.com` :
la page de connexion doit s'afficher avec un cadenas valide. Testez aussi
`http://www.arcompt.com` : vous devez atterrir sur `https://arcompt.com`.

---

## 7. Les migrations de base de données

**Elles sont automatiques.** Le service `migrate` de `docker-compose.prod.yml`
s'exécute avant l'API, et l'API ne démarre que si cette tâche s'est terminée
avec succès (`condition: service_completed_successfully`). Chaque `arc up -d`
rejoue cette tâche ; les migrations déjà appliquées sont ignorées.

La tâche fait deux choses, dans cet ordre :

1. **`node infra/docker/ops/migrate.mjs`** applique les fichiers manquants de
   `packages/db/migrations/`, chacun dans sa transaction, **sous un verrou
   consultatif PostgreSQL**. Deux déploiements lancés en même temps ne peuvent
   donc pas rejouer la même migration : le second attend, en le disant, jusqu'à
   `MIGRATION_LOCK_TIMEOUT` secondes (300 par défaut).
2. **`node infra/docker/ops/provision-role.mjs`** crée — ou met à jour — le rôle
   de connexion `arcompt_app_login`, membre du groupe `arcompt_app`, puis
   **vérifie le modèle de droits obtenu** : que l'application peut bien faire ce
   dont elle a besoin, et surtout qu'elle ne peut pas supprimer une clé de paie,
   réécrire la piste d'audit ni toucher à l'historique des migrations. Si un seul
   contrôle échoue, la tâche s'arrête en échec et l'API ne démarre pas.

Ce second script n'est qu'un point d'entrée sans logique propre : tout vit dans
`packages/db/src/provision.ts`. Depuis un dépôt installé, l'équivalent exact est
`pnpm exec tsx scripts/provision-app-role.mts` ; l'image de production n'embarque
ni pnpm ni tsx, d'où la variante `.mjs`.

Voir le déroulé :

```bash
arc logs migrate
```

La rejouer à la main (par exemple après avoir changé `APP_DB_PASSWORD`, ce qui
est aussi la procédure de rotation du mot de passe) :

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

Ouvrez `https://auth.arcompt.com` et connectez-vous avec `KEYCLOAK_ADMIN` /
`KEYCLOAK_ADMIN_PASSWORD`.

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
   - *Valid redirect URIs* : `https://arcompt.com/api/auth/callback/keycloak`
   - *Valid post logout redirect URIs* : `https://arcompt.com/*`
   - *Web origins* : `https://arcompt.com`
   - Onglet **Credentials** → copiez le *Client secret* dans
     `KEYCLOAK_WEB_CLIENT_SECRET`.

Ces trois URL sont en `https://arcompt.com`, **sans `www`** : c'est le nom
canonique, et Caddy redirige `www` vers lui avant même que Keycloak n'entre en
jeu.

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

### 9.1 Le compte côté ARCOMPT

Le dépôt fournit un script fait exactement pour ça. Il crée une organisation, un
dossier avec son plan de comptes, un exercice, deux tiers, quatre écritures
validées et un brouillon — de quoi remplir tous les écrans dès la première
connexion :

```bash
arc run --rm migrate node scripts/create-test-account.mjs --email prenom.nom@cabinet.ci
```

Options utiles : `--name` (nom affiché), `--org` (nom de l'organisation),
`--company` (nom du dossier), `--year` (exercice). Le script est **rejouable** :
relancé avec la même adresse, il ne crée rien et réimprime les informations.

Il affiche à la fin l'identifiant du dossier, celui de l'utilisateur, et la
marche à suivre pour la connexion. Notez-les.

> Depuis un dépôt installé (poste de développement), le même script s'appelle
> `pnpm exec tsx scripts/create-test-account.mts`. Dans l'image de production, il
> a été compilé en `.mjs` et s'exécute avec `node`, sans tsx.

### 9.2 L'identité côté Keycloak

Realm `arcompt` → **Users** → **Add user** :

- *Email* : exactement l'adresse passée à `--email`.
- *Email verified* : **On** — sans cela, le rattachement automatique est refusé,
  délibérément (sinon s'inscrire avec l'adresse d'autrui suffirait à prendre son
  dossier).
- *Username* : la même adresse fait très bien l'affaire.

Onglet **Credentials** → *Set password* → décochez *Temporary* si vous voulez
éviter le changement forcé au premier accès.

### 9.3 Se connecter

`https://arcompt.com` → *Se connecter* → redirection vers Keycloak → retour sur
le tableau de bord. Le rattachement `app_user.keycloak_sub` s'est fait tout seul.

Si ce n'est pas le cas, le rattachement manuel est décrit dans
`infra/keycloak/README.md`.

### 9.4 Note sur le second facteur

L'API applique `organization.mfa_required` : quand ce drapeau est vrai, elle
refuse en 403 tout jeton qui ne prouve pas un second facteur (claim `amr`
contenant `mfa`/`otp`/`hwk`/`swk`, ou `acr` ≥ 2).

Le script du § 9.1 crée l'organisation avec `mfa_required = false` : rien ne vous
bloquera pour ce premier test. En revanche, le jeu de démonstration du portail
(`SEED_FIRM=1`) crée, lui, une organisation qui **exige** le second facteur —
si vous l'utilisez, il faudra enrôler l'utilisateur en TOTP et déclarer la
correspondance ACR dans Keycloak (voir `infra/keycloak/README.md`), ou passer le
drapeau à `false` :

```bash
arc exec postgres psql -U arcompt -d arcompt -c \
  "UPDATE organization SET mfa_required = false WHERE id = '<uuid>'"
```

Avant une utilisation réelle par un cabinet, c'est l'inverse qu'il faut faire :
activer le second facteur et l'exiger.

---

## 10. Vérifier que tout marche

```bash
arc ps                                     # tout en « running », api et web en « healthy »
curl -sS https://api.arcompt.com/health    # {"ok":true,"service":"arcompt-api"}
curl -sSo /dev/null -w '%{http_code}\n' https://api.arcompt.com/health/ready   # 200
curl -sSo /dev/null -w '%{http_code}\n' https://arcompt.com                     # 200 ou 307
curl -sSo /dev/null -w '%{http_code} %{redirect_url}\n' http://www.arcompt.com  # 308 https://arcompt.com/
```

Les deux sondes de l'API ne disent pas la même chose : `/health` répond tant que
le processus vit (« faut-il redémarrer ce conteneur ? »), `/health/ready` fait un
aller-retour réel vers PostgreSQL et passe à 503 dès que l'arrêt en douceur
commence (« cette instance peut-elle servir ? »).

Puis, dans le navigateur, le parcours qui prouve que la chaîne complète tient :

1. se connecter ;
2. ouvrir le dossier, aller au grand livre ;
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

La restauration recrée le rôle de groupe `arcompt_app` mais **pas** le rôle de
connexion `arcompt_app_login`, qui est propre au serveur. C'est
`arc run --rm migrate` qui le remet en place — il est rejoué automatiquement par
le `arc up -d` ci-dessus.

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
3. **Le volume `caddy_data`** — les certificats et la clé de compte ACME. Sans
   lui, Caddy les redemande, ce qui est sans conséquence sauf si vous redémarrez
   souvent (§ 4.5, quotas).

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
dig +short arcompt.com               # doit rendre l'IP du serveur, et elle seule
sudo ss -lntp | grep -E ':80|:443'   # seul Caddy doit y être
sudo ufw status                      # 80 et 443 ouverts
```

Presque toujours du DNS ou le port 80 : enregistrement `A` de parking GoDaddy
resté en place, *Forwarding* actif, serveurs de noms délégués ailleurs (§ 4.3),
ou pare-feu de l'hébergeur qui bloque le port 80 alors que celui du serveur
l'autorise (§ 4.5).

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
   `https://auth.arcompt.com/realms/arcompt`, sans barre oblique finale, en
   `https`.
3. L'horloge du serveur dérive : `timedatectl status` doit indiquer
   `System clock synchronized: yes`. Un décalage de quelques minutes suffit à
   faire rejeter tous les jetons.

Pour trancher : copiez le jeton d'accès depuis les outils de développement du
navigateur et décodez son deuxième segment (`aud`, `iss`, `exp`).

### Connexion acceptée, mais 403 partout

- **Second facteur manquant** alors que l'organisation l'exige (§ 9.4).
- **Rattachement non fait** : l'adresse diffère entre Keycloak et `app_user`, ou
  n'est pas vérifiée dans Keycloak.

```bash
arc exec postgres psql -U arcompt -d arcompt -c \
  "SELECT email, keycloak_sub IS NOT NULL AS rattache, suspended_at FROM app_user"
```

- **Aucune appartenance** : l'utilisateur existe mais n'est membre d'aucun
  dossier (`company_member`).

### Déconnexion en naviguant, ou boucle de connexion

Vérifiez que vous êtes bien sur `https://arcompt.com` et non sur
`https://www.arcompt.com`. Le cookie de session est attaché au nom canonique ;
la redirection du § 4.2 doit vous y amener avant toute connexion. Si elle ne se
fait pas, c'est que l'enregistrement `www` manque ou que son certificat n'a pas
pu être émis.

### Keycloak boucle sur `http://` ou refuse la redirection

`KC_PROXY_HEADERS=xforwarded` et `KC_HOSTNAME` sont déjà posés par
`docker-compose.prod.yml`. Vérifiez que `AUTH_DOMAIN` vaut bien `auth.arcompt.com`
et que l'URI de redirection du client `arcompt-web` est en `https`, sur le nom
canonique (§ 8.2).

### Le téléchargement d'un PDF échoue

Seul le rendu PDF utilise Chromium. Le message `Chromium introuvable` signifie
que l'image a été modifiée ; une erreur de mémoire signifie que la machine est
trop petite (§ 2) — ajoutez le fichier d'échange du § 3.4.

### Requêtes coupées à chaque redéploiement

`SHUTDOWN_GRACE_MS` doit rester **inférieure** à `STOP_GRACE_PERIOD` (§ 5.3),
sinon Docker envoie SIGKILL pendant que l'API essaie encore de finir les
requêtes en cours.

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
| Second facteur | Désactivé par défaut sur les organisations créées | À activer avant tout usage par un cabinet (§ 9.4) |
| Haute disponibilité | Une seule machine, un seul exemplaire de chaque service | Toute mise à jour coupe le service quelques secondes ; une panne du serveur coupe tout |
| Sauvegardes hors site | À mettre en place (§ 13) | Un disque perdu = la comptabilité perdue |
| Surveillance | `SENTRY_DSN` et `SECURITY_ALERT_WEBHOOK_URL` vides | Les alertes de sécurité restent dans les journaux et ne réveillent personne |

Voir aussi `docs/SECURITY.md` et `docs/OPERATIONS.md`.
