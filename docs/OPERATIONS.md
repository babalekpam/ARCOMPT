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
| Messagerie | Relais SMTP (`SMTP_*`, `MAIL_*`) | Invitations, demandes de pièces, notifications d'accès, relances |

## Mise en route

```bash
cp .env.example .env            # renseigner les secrets depuis le gestionnaire de secrets
docker compose up -d            # PostgreSQL + Redis
pnpm install
pnpm db:migrate                 # toutes les migrations, sous le compte propriétaire du schéma

# Une fois par base : créer le rôle de connexion applicatif, puis basculer
# DATABASE_URL de l'API et du worker dessus (voir « Rôles SQL »).
APP_DB_PASSWORD='<mot de passe fort>' pnpm exec tsx scripts/provision-app-role.mts

SEED_FIRM=1 pnpm db:seed        # dossier PME + cabinet de démonstration (développement uniquement)
pnpm preflight                  # contrôle complet : base, RLS, droits, identité, messagerie
pnpm dev                        # web :3000, API :4000
pnpm worker                     # dans un second terminal
```

Ordre imposé : `db:migrate` crée le rôle de groupe `arcompt_app` et pose ses
droits ; `provision-app-role` ne fait que lui rattacher un rôle de connexion.
Lancé avant les migrations, il refuse avec un message explicite.

## Configuration de production : démarrage strict

Avec `NODE_ENV=production`, l'API refuse de démarrer tant que les secrets et les connecteurs ne sont pas réels : mode d'authentification, secrets de signature, clé de chiffrement de la paie, stockage objet, passerelle IA, antivirus, canal sortant WhatsApp, envoi des e-mails, opérateur de paiement et connecteur de certification. La validation de démarrage **rassemble tous les problèmes et échoue avec la liste complète**, plutôt que d'échouer au premier : un déploiement se corrige en une passe.

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

- `AUTH_MODE=clerk` : créez ou invitez dans Clerk un utilisateur portant
  **exactement** la même adresse, avec courriel vérifié. Le rattachement au
  compte ARCOMPT se fait tout seul au premier appel (`auth_link_subject`,
  migration 0009) : aucun SQL à la main. Clerk fournit aussi la récupération
  du mot de passe.
- `AUTH_MODE=dev` (poste local uniquement) : les deux identifiants imprimés
  suffisent, en en-têtes HTTP.

> **LEGACY :** toute ancienne instruction Keycloak/Auth.js ci-dessous ou dans
> les guides de déploiement ne s'applique plus au chemin Clerk actuel. Consultez
> `docs/DEPLOYMENT-CLERK.md` avant toute publication.

Options : `--name`, `--org`, `--company`, `--year`. Réexécuté à l'identique, le
script ne crée rien et réimprime les informations ; si l'adresse existe dans une
autre configuration, il refuse en disant ce qu'il a trouvé plutôt que d'écraser
un compte. Le pack `tg` est en statut `DRAFT` : taux et barèmes restent
indicatifs tant que l'expert-comptable référent ne les a pas validés.

## Envoi des e-mails

ARCOMPT envoie par SMTP, et **ne connaît aucun fournisseur** : `packages/mailer`
parle à n'importe quel service qui accepte du SMTP authentifié. Changer
d'opérateur, c'est changer quatre variables et redéployer, rien d'autre.

| Variable | Rôle |
| --- | --- |
| `SMTP_HOST` | Hôte du relais. Son absence est ce qui bascule l'envoi en mode neutre. |
| `SMTP_PORT` | 587 ou 25 (STARTTLS, exigé), 465 (TLS dès la connexion). Défaut 587. |
| `SMTP_SECURE` | `1` pour le TLS implicite. Non renseignée, le port décide (465 → implicite). |
| `SMTP_USER`, `SMTP_PASSWORD` | Identifiants du relais ; facultatifs si l'authentification se fait par adresse IP. |
| `MAIL_FROM_ADDRESS` | Adresse d'expédition. C'est **son** domaine que SPF et DKIM doivent couvrir. |
| `MAIL_FROM_NAME` | Nom affiché devant l'adresse. |
| `MAIL_REPLY_TO` | Adresse de réponse par défaut, quand elle diffère de l'expéditeur. |
| `MAIL_LEGAL_FOOTER` | Mentions légales en pied de chaque message : raison sociale, adresse, RCCM, contact. |
| `ALLOW_INSECURE_MAIL` | Opt-out explicite : accepter en production que rien ne parte. |

Sans `SMTP_HOST` **et** `MAIL_FROM_ADDRESS`, l'expéditeur est neutre : chaque
message est écrit en entier sur la sortie standard et ne quitte pas le serveur.
C'est le confort du poste de développement, et un mensonge en production — une
invitation dont le code à usage unique ne part pas est une invitation
inutilisable. `createMailerFromEnv()` refuse donc ce repli quand
`NODE_ENV=production`, sauf `ALLOW_INSECURE_MAIL=1` : l'API s'arrête au montage
des routes, avant d'écouter, en nommant les variables manquantes. Une
configuration à moitié posée (`SMTP_HOST` sans `MAIL_FROM_ADDRESS`) est refusée
partout, production ou non : ce n'est pas un repli, c'est une erreur.

Ce qui part, et quand :

| Message | Déclencheur | Destinataire |
| --- | --- | --- |
| Invitation au portail | `POST /v1/portal/org/invitations` | La personne invitée. Porte le lien d'acceptation et le code à usage unique. |
| Demande de pièce manquante | `POST /v1/portal/missing-documents` avec `channel: "EMAIL"` | Le tiers, ou l'adresse saisie. |
| Accès technique à un dossier | `AccessService.recordAdminAccess()` | Les dirigeants (`OWNER`) du dossier. |
| Accès d'urgence (break-glass) | Le même, avec une demande approuvée | Les dirigeants du dossier ; message distinct, qui dit la fin de l'accès. |
| Relance de règlement | `POST /v1/sales/:id/dunning`, ou la tâche `dunning.send` | Le client, à l'adresse portée par sa fiche tiers. |

Les modèles sont en français, vouvoiement, sans emoji ni ton commercial
(`packages/mailer/src/templates.ts`). Chaque message dit pourquoi son
destinataire le reçoit — un client de PME n'a jamais entendu parler d'ARCOMPT —
et se termine par `MAIL_LEGAL_FOOTER`. Le corps de référence est le texte brut ;
le HTML en est dérivé et n'ajoute rien, donc un client qui ne l'affiche pas ne
perd rien. Une variable manquante fait échouer le rendu : mieux vaut ne pas
envoyer que remettre un message où s'affiche `{{numero_facture}}`.

**Ce qu'« envoyé » veut dire.** Une ligne de relance (`dunning`) n'est écrite
qu'après acceptation du message par le serveur de messagerie ; un envoi refusé
laisse l'écran des créances échues au niveau précédent, et consigne la tentative
dans `dunning_log` (statut `FAILED`, avec le motif). De même, une demande de
pièce dont l'envoi échoue reste enregistrée avec `sent_at` nul et l'API répond
`NOTIFY_FAILED`. Aucun échec n'est avalé.

### SPF et DKIM : obligatoires

Envoyer depuis un domaine que l'on possède ne suffit pas. Tant que le domaine de
`MAIL_FROM_ADDRESS` n'autorise pas explicitement le fournisseur, les messages
seront **classés en indésirables ou rejetés** par les destinataires — et une
relance de règlement qui finit en indésirable ne relance personne.

Deux enregistrements DNS à créer sur le domaine de `MAIL_FROM_ADDRESS`, chez le
bureau d'enregistrement qui héberge sa zone :

1. **SPF** — un enregistrement `TXT` à la racine du domaine, autorisant les
   serveurs du fournisseur à émettre en son nom. Un seul enregistrement SPF par
   domaine : s'il en existe déjà un, on ajoute le mécanisme du fournisseur
   dedans, on n'en crée pas un second.

   ```
   Type : TXT     Nom : @     Valeur : v=spf1 include:<domaine-du-fournisseur> ~all
   ```

2. **DKIM** — un ou plusieurs `TXT` (ou `CNAME`, selon le fournisseur) sur le
   sélecteur qu'il indique, portant la clé publique qui vérifiera sa signature.

   ```
   Type : TXT     Nom : <sélecteur>._domainkey     Valeur : v=DKIM1; k=rsa; p=<clé publique>
   ```

Le contenu exact de ces deux valeurs est donné par le fournisseur retenu au
moment où le domaine d'envoi est déclaré chez lui ; ARCOMPT ne peut pas le
deviner. Un troisième enregistrement, **DMARC**
(`_dmarc`, `v=DMARC1; p=none; rua=mailto:…`), n'est pas exigé pour délivrer mais
indique quoi faire des messages non authentifiés et fait remonter des rapports :
posez-le en `p=none` le temps d'observer, avant de durcir.

Vérification, une fois les enregistrements propagés : envoyer une invitation à
une adresse extérieure, ouvrir les en-têtes du message reçu et contrôler que
`Authentication-Results` porte `spf=pass` **et** `dkim=pass`. Tant que l'un des
deux manque, ne lancez pas de campagne de relances.

Plus simple qu'une invitation réelle pour cette vérification :

```
pnpm mail:check --to vous@exemple.com     # configuration, connexion, envoi réel
pnpm mail:check --dry                     # configuration et connexion seulement
```

Le script éprouve les trois étapes séparément — configuration, authentification,
remise — parce qu'elles échouent pour des raisons différentes. Une
authentification acceptée ne prouve pas qu'un message sorte : quota, expéditeur
refusé ou domaine non vérifié échouent tous APRÈS. Ce qu'il ne prouve pas non
plus : l'arrivée en boîte de réception. Cela ne se lit que dans l'en-tête du
message reçu, et le message envoyé le rappelle.

### Le déploiement arcompt.com : Zoho, info@arcompt.com

Le code ne connaît aucun fournisseur et n'en connaîtra pas : ce qui suit décrit
**ce déploiement**, pas une dépendance. Changer de fournisseur reste six
variables d'environnement.

| Variable | Valeur | Pourquoi celle-là |
|---|---|---|
| `SMTP_HOST` | `smtppro.zoho.com` | **Pas `smtp.zoho.com`.** Voir ci-dessous. |
| `SMTP_PORT` | `465` | TLS dès la connexion, rien ne s'ouvre en clair. |
| `SMTP_SECURE` | `1` | Cohérent avec 465. Sur 587, laisser vide : STARTTLS est alors exigé. |
| `SMTP_USER` | `info@arcompt.com` | L'adresse complète, pas un nom d'utilisateur. |
| `SMTP_PASSWORD` | mot de passe d'application | Jamais celui de la boîte. Voir ci-dessous. |
| `MAIL_FROM_ADDRESS` | `info@arcompt.com` | Zoho exige qu'elle corresponde à `SMTP_USER`. |

Quatre pièges, dans l'ordre où ils se présentent :

1. **`smtppro`, pas `smtp`.** Une adresse sur domaine propre passe par
   `smtppro.zoho.com`. Le `smtp.zoho.com` des comptes gratuits refuse
   l'authentification d'un compte à domaine, et l'erreur ressemble à un mot de
   passe faux — on cherche alors des heures au mauvais endroit.
2. **Le suffixe suit le centre de données du compte Zoho, pas le pays du
   dossier.** `smtppro.zoho.com` (US), `.eu`, `.in`, `.com.au`. Un compte ouvert
   depuis l'Europe n'est pas forcément européen. Le bon suffixe se lit dans la
   console Zoho ; le mauvais donne exactement le même échec qu'au point 1.
3. **Mot de passe d'application.** La double authentification doit être activée
   sur `info@arcompt.com` — c'est la boîte qui expédie les invitations au
   portail. Une fois activée, Zoho refuse le mot de passe de la boîte en SMTP :
   `SMTP_PASSWORD` est un mot de passe d'application créé dans
   `accounts.zoho.com` → Sécurité → Mots de passe d'application, dédié à
   ARCOMPT, révocable seul.
4. **Quota d'envoi.** Zoho borne le nombre de messages par jour selon l'offre.
   Une campagne de relances sur un portefeuille entier peut l'atteindre ; les
   messages suivants sont alors refusés APRÈS authentification, et le module de
   relance n'enregistre rien comme envoyé (c'est le contrat, mais la relance
   n'est pas partie pour autant).

#### Les enregistrements DNS à publier sur arcompt.com

La zone d'`arcompt.com` est chez GoDaddy ; ces trois enregistrements s'y créent.
Les valeurs de SPF et DMARC sont données ici en entier — celle de DKIM, non :
elle contient la clé publique que Zoho génère pour ce domaine, et personne
d'autre ne peut la produire.

```
SPF     Type : TXT   Nom : @                  Valeur : v=spf1 include:zoho.com ~all
DKIM    Type : TXT   Nom : zmail._domainkey   Valeur : (copiée depuis la console Zoho)
DMARC   Type : TXT   Nom : _dmarc             Valeur : v=DMARC1; p=none; rua=mailto:info@arcompt.com
```

- **SPF** : un seul enregistrement SPF par domaine. S'il en existe déjà un sur
  `arcompt.com`, ajoutez-y `include:zoho.com` au lieu d'en créer un second —
  deux enregistrements SPF produisent un `PermError` et **aucun** des deux ne
  s'applique, ce qui est pire que pas de SPF du tout.
- **DKIM** : `zmail` est le sélecteur que Zoho propose par défaut. La valeur se
  récupère dans la console d'administration Zoho, sous Domaine →
  Authentification des e-mails → DKIM, puis se colle telle quelle. Zoho a un
  bouton « Vérifier » qui relit le DNS : ne le cliquez qu'après propagation.
- **DMARC** : `p=none` observe sans rien rejeter. Gardez-le le temps de lire
  quelques rapports, puis durcissez en `p=quarantine`. Poser `p=reject` avant
  que SPF et DKIM ne passent tous les deux ferait rejeter vos propres
  invitations.

Ordre d'exécution : publier SPF et DKIM, attendre la propagation, faire vérifier
par Zoho, puis `pnpm mail:check --to …` et lire l'en-tête `Authentication-Results`
du message reçu. Tant que `spf=pass` et `dkim=pass` n'y sont pas tous les deux,
n'invitez pas l'expert-comptable : son code à usage unique partirait en
indésirables.

## Secrets et clés

| Secret | Usage | Rotation |
| --- | --- | --- |
| `PAYROLL_ENCRYPTION_KEY` | Clé maître enveloppant les clés de données de paie par dossier | Annuelle : `PayrollService.rotateTenantKey()` re-chiffre chaque dossier |
| `KEYCLOAK_CLIENT_SECRET` | Client OIDC web | Annuelle |
| `PAYMENT_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET` | Signatures HMAC des webhooks | À chaque changement de fournisseur |
| `ANTHROPIC_API_KEY` | Passerelle IA | Trimestrielle |
| `R2_SECRET_ACCESS_KEY` | Object store | Annuelle |
| `SMTP_PASSWORD` | Relais d'envoi des e-mails | À chaque changement de fournisseur |
| `BACKUP_ENCRYPTION_KEY` | Chiffrement des archives de sauvegarde | Annuelle. **La rotation ne rechiffre pas les archives existantes** : gardez l'ancienne clé au coffre aussi longtemps que les sauvegardes qu'elle ouvre. Une clé perdue = des sauvegardes perdues. |
| `ANCHOR_SIGNING_KEY` | Signature Ed25519 des reçus d'ancre (publieur `endpoint`) | Annuelle. Conservez et publiez les clés **publiques** successives : un reçu de 2026 se vérifie avec la clé de 2026. |

Jamais dans le code, les images ni les journaux : `apps/api/src/security.ts` masque les motifs de secrets dans les journaux.

**Pas de gestionnaire de clés.** `packages/payroll/src/crypto.ts` définit l'interface `KeyProvider`, mais seule `EnvKeyProvider` est livrée : la clé maître est lue dans `PAYROLL_ENCRYPTION_KEY`. Il n'existe aucune implémentation KMS dans le dépôt. Injectez donc cette variable depuis le gestionnaire de secrets de l'hébergeur au démarrage du conteneur, et traitez sa rotation comme une opération manuelle : la chaîne « KMS → application » décrite dans `SECURITY.md` reste à construire.

## Sauvegardes et reprise

Trois scripts, une seule idée : **une sauvegarde qu'on n'a jamais relue n'est
pas une sauvegarde, c'est un fichier**. Chacun fait donc plus que son nom le
laisse croire — la sauvegarde produit de quoi se vérifier, la restauration
refuse les cibles ambiguës, et l'exercice contrôle ce qu'il a restauré au lieu
de se féliciter d'un `psql` silencieux.

| Script | Rôle |
| --- | --- |
| `scripts/backup.mts` | `pg_dump` → gzip → AES-256-GCM, plus un manifeste scellé (HMAC). `--verify` relit une archive existante de bout en bout. |
| `scripts/restore.mts` | Déchiffre, confronte au manifeste, restaure. Refuse par défaut toute cible qui n'annonce pas être jetable. |
| `scripts/restore-drill.mts` | Exercice : crée une base jetable, y restaure, **vérifie**, rapporte, supprime. Sort en code 1 au premier contrôle rouge. |

Objectifs inchangés : RPO ≤ 15 min, RTO ≤ 4 h ; pas de fenêtre de maintenance
autour des échéances fiscales (`GET /v1/tax/calendar`). Les scripts ne
remplacent pas le PITR de l'hébergeur — un dump quotidien ne tient pas un RPO de
15 minutes. Ils couvrent ce que le PITR ne couvre pas : une copie **hors de
l'hébergeur**, chiffrée sous une clé qui n'est pas la sienne, et la preuve
régulière qu'elle se restaure.

### Sauvegarder

```bash
BACKUP_ENCRYPTION_KEY="$(cat /run/secrets/backup_key)" \
DATABASE_URL=postgres://<compte_de_sauvegarde>@<hôte>:5432/<base> \
  pnpm exec tsx scripts/backup.mts --out /var/backups/arcompt
```

Produit deux fichiers : `<base>-<horodatage>.sql.gz.enc` et son
`.manifest.json`. **Copiez les deux** hors site : l'archive sans son manifeste
reste restaurable, mais plus vérifiable.

- `BACKUP_ENCRYPTION_KEY` : base64 de 32 octets (`openssl rand -base64 32`),
  injectée depuis le gestionnaire de secrets. **Absente, le script refuse** : il
  n'existe aucun repli « sauvegarde en clair ». Une archive ARCOMPT contient dix
  ans d'écritures, des salaires et des identifiants fiscaux.
- Chaque archive tire sa propre clé de données (HKDF sur un sel aléatoire) ;
  l'en-tête (sel, IV, base d'origine) est authentifié par le sceau GCM, donc il
  ne se maquille pas.
- Le manifeste porte l'empreinte du chiffré, l'empreinte du SQL en clair, la
  liste des migrations appliquées et des décomptes témoins, le tout scellé par
  un HMAC dérivé de la même clé : un décompte retouché à la main est démasqué.
- Perdre `BACKUP_ENCRYPTION_KEY`, c'est perdre toutes les sauvegardes prises
  sous cette clé. Elle vit dans le gestionnaire de secrets **et** dans le
  coffre de reprise, pas seulement dans la configuration du conteneur.

Contrôle d'une archive, sans rien restaurer :

```bash
BACKUP_ENCRYPTION_KEY=… pnpm exec tsx scripts/backup.mts --verify /var/backups/arcompt/<archive>
```

Le script déchiffre l'archive **entièrement** (le sceau GCM ne se vérifie qu'au
dernier octet) et confronte les deux empreintes au manifeste. Un octet retourné,
un transfert interrompu ou une clé différente échouent ici, pas le jour de la
panne.

### Restaurer

```bash
# cible jetable : le nom l'annonce, rien d'autre à faire
BACKUP_ENCRYPTION_KEY=… pnpm exec tsx scripts/restore.mts \
  --file /var/backups/arcompt/<archive> \
  --target postgres://arcompt@<hôte>:5432/arcompt_drill_20250304

# vraie reprise, sur une base qui n'est pas jetable : deux gestes exigés
ALLOW_DESTRUCTIVE_RESTORE=1 BACKUP_ENCRYPTION_KEY=… pnpm exec tsx scripts/restore.mts \
  --file … --target postgres://…/arcompt --confirm arcompt --reset
```

Le mode de défaillance contre lequel ce script est écrit n'est pas « la
restauration échoue » : c'est **« la restauration réussit, sur la mauvaise
base »**. Une commande juste, lancée avec le `DATABASE_URL` de production encore
dans le terminal, détruit tout sans rien afficher d'anormal. Trois refus, dans
cet ordre :

1. `--target` est obligatoire : `DATABASE_URL` n'est jamais pris par défaut ;
2. si le nom de la base n'annonce pas une cible jetable (`…_drill`, `…_test`,
   `scratch_…`, `…_restore`, `…_tmp`, `…_sandbox`), il faut **retaper ce nom**
   (`--confirm <base>`) **et** poser `ALLOW_DESTRUCTIVE_RESTORE=1`. L'un sans
   l'autre ne suffit pas : une variable oubliée dans un shell et un nom
   copié-collé au hasard doivent rester sans effet ;
3. si la base contient déjà des dossiers, il faut `--reset`.

Le chemin de la vraie reprise existe donc, il est documenté, et il ne s'emprunte
pas par distraction. Après restauration, le script confronte les décomptes au
manifeste et **échoue** s'ils divergent : une restauration partielle ne se met
pas en service.

Restauration sur un **autre cluster** : le dump conserve propriétaires et
privilèges (c'est ce qui rend le modèle de droits vérifiable). Créez donc
d'abord les rôles sur le cluster d'accueil — `arcompt_app` naît d'une migration,
le rôle de connexion vient de `scripts/provision-app-role.mts`.

### Exercice trimestriel

```bash
BACKUP_ENCRYPTION_KEY=… DATABASE_URL=postgres://<compte_de_service>@<hôte>:5432/<base> \
  pnpm exec tsx scripts/restore-drill.mts            # prend la dernière archive de ./backups
```

Le harnais crée `arcompt_drill_<horodatage>`, y restaure l'archive, puis
**contrôle ce qu'il a restauré** — parce qu'un `psql` qui rend la main sans
erreur prouve que du SQL s'est exécuté, pas que la comptabilité est intacte :

| Contrôle | Ce qu'il prouve |
| --- | --- |
| Restauration | L'archive se déchiffre et s'exécute entièrement |
| Historique des migrations | Le schéma restauré porte les migrations de la sauvegarde |
| Décomptes de lignes | Aucune table n'a perdu de ligne en chemin |
| Énumération des dossiers | Les contrôles suivants portent sur **tous** les dossiers, pas sur un sous-ensemble |
| Chaînes de hash du grand livre | `Ledger.verifyChain` par dossier et par journal : hashes et numéros se recalculent |
| Chaîne de la piste d'audit | Chaînage **et** recalcul du digest de chaque ligne d'`audit_log` |
| Chaîne d'ancres | `verifyAnchorChain`, **et** recalcul de chaque racine de Merkle depuis les données restaurées |
| Soldes par compte et période | `account_balance` recalculé depuis les lignes d'écriture |

Le rapport dit, pour chaque contrôle, **ce qui a été examiné** (nombre
d'écritures, de lignes d'audit, d'ancres). Un contrôle qui n'avait rien à
examiner — sauvegarde sans ancre, base sans écriture validée — est marqué
`IGNORÉ` et n'est jamais compté comme réussi : c'est la différence entre « tout
va bien » et « je n'ai rien regardé ». Tout contrôle rouge fait sortir le script
en code 1 et **conserve** la base d'exercice pour l'autopsie ; un exercice
réussi la supprime (`--keep` pour la garder).

Consignez dans le registre d'exploitation : la date, l'archive éprouvée, la
durée totale (c'est votre mesure de RTO réelle) et le rapport.

### Exercice annuel de reconstruction des clés

L'exercice trimestriel ne touche pas aux clés. Une fois par an, refaites la
chaîne complète depuis le coffre, sur la base d'exercice :

1. récupérer `BACKUP_ENCRYPTION_KEY` **depuis le coffre de reprise**, pas depuis
   la configuration du conteneur de production — c'est le geste éprouvé ;
2. dérouler `restore-drill.mts` avec cette seule copie ;
3. récupérer de même `PAYROLL_ENCRYPTION_KEY` et déchiffrer un bulletin sur la
   base restaurée (`PayrollService`) : une sauvegarde dont les données de paie
   sont irrécupérables n'est pas une sauvegarde ;
4. récupérer `ANCHOR_SIGNING_KEY` si le publieur « endpoint » est en service, et
   revérifier la signature d'un reçu d'ancre déjà publié.

## Ancrage externe

`packages/ledger/src/anchoring.ts` calcule la racine de Merkle quotidienne, la
chaîne d'ancres et les preuves d'inclusion. Depuis la migration
`0013_anchoring.sql`, ces ancres sont **conservées** (`ledger_anchor`),
**publiées** hors de la plateforme et **servies** par l'API.

### Ce qui est ancré, et pourquoi

Le produit tient deux chaînes de hash : `journal_entry.hash` (une par journal) et
`audit_log.hash` (une par dossier). **L'ancre couvre les deux.** N'ancrer que les
écritures prouverait qu'une écriture existait le 3 mars sans rien prouver de qui
l'a validée, ni du déverrouillage de période qui l'a précédée — la moitié de ce
que l'engagement n° 10 annonce. Chaque feuille porte son domaine (`ENTRY:` /
`AUDIT:`), ce qui interdit de présenter un hash d'audit à la place d'un hash
d'écriture dans une preuve.

Une ancre par dossier et par journée **révolue** (UTC) ayant produit quelque
chose. Le jour courant n'est jamais ancré : une journée ouverte reçoit encore des
écritures, et sa racine ne se recalculerait plus demain. Les journées sans
activité ne sont pas ancrées : la chaîne n'exige pas des jours contigus.

### Configuration

| Variable | Rôle |
| --- | --- |
| `ANCHOR_PUBLISHER` | `rfc3161`, `endpoint`, ou `memory` (hors production). **Absente : l'ancrage est coupé**, et annoncé comme dégradé au démarrage. |
| `ANCHOR_TSA_URL` | `rfc3161` : URL de l'autorité d'horodatage (https exigé en production). |
| `ANCHOR_TSA_AUTH` | `rfc3161` : en-tête `Authorization` si la TSA est sous contrat. Facultatif. |
| `ANCHOR_TSA_POLICY_OID` | `rfc3161` : OID de politique exigé de la TSA. Facultatif. |
| `ANCHOR_ENDPOINT_URL` | `endpoint` : point de dépôt des reçus signés (https exigé en production). |
| `ANCHOR_SIGNING_KEY` | `endpoint` : clé privée Ed25519, PEM PKCS#8 ou base64 du DER (`openssl genpkey -algorithm ed25519 -outform DER \| base64 -w0`). |
| `ANCHOR_ENDPOINT_AUTH` | `endpoint` : en-tête `Authorization` du point de dépôt. Facultatif. |

Règle habituelle de la maison : variable absente = fonction coupée et annoncée,
configuration posée à moitié = refus de démarrer en production,
simulateur = interdit en production. `ANCHOR_PUBLISHER=memory` garde les ancres
dans la mémoire du processus : utile en développement, refusé si
`NODE_ENV=production`. **Aucune ancre n'est jamais marquée publiée sans qu'un
tiers en ait accusé réception** : en cas d'échec, elle reste `FAILED` avec son
motif, et la prochaine exécution la reprend.

Lequel choisir. `rfc3161` est le seul qui atteste une **date** opposable : le
jeton est signé par un tiers et se vérifie avec sa chaîne de certification
publique, des années plus tard, sans nous. `endpoint` prouve l'origine et
l'intégrité du reçu (signature Ed25519) mais pas sa date — celle-ci ne vaut que
ce que vaut le registre du destinataire. Prenez `rfc3161` ; réservez `endpoint`
au cas où aucune TSA n'est disponible, et remettez alors la clé **publique** au
commissaire aux comptes.

### Tâche quotidienne

```bash
ANCHOR_PUBLISHER=rfc3161 ANCHOR_TSA_URL=https://<autorité>/tsr \
DATABASE_URL=postgres://<compte_de_service>@<hôte>:5432/<base> \
  pnpm exec tsx scripts/anchor-daily.mts
```

À poser dans l'ordonnanceur, une fois par jour, après minuit UTC. Idempotent :
relancé, il ne refait que ce qui manque ; une nuit manquée est rattrapée le
lendemain sans trou dans la chaîne. `--dry-run` énumère sans rien écrire ;
`--tenant <uuid>` restreint à un dossier.

Le script énumère `company`, qui est en **RLS forcée** : employez le compte de
migration ou un compte de service, jamais le rôle applicatif. S'il n'énumère
aucun dossier, il le dit et sort en erreur plutôt que de terminer sur un succès
vide. Il sort également en erreur si une publication a échoué, ou si une journée
d'activité est devenue inancrable (activité antérieure à la dernière ancre :
signe d'une écriture antidatée ou d'une horloge qui a reculé).

Le même travail est déclenchable à la demande par l'API :
`POST /v1/anchors/build` (rôles OWNER, ACCOUNTANT, REVIEWER), avec ou sans
`{"day":"AAAA-MM-JJ"}`.

### Ce qu'un auditeur fait d'une ancre

`GET /v1/anchors/proof?entry=<uuid>` (ou `?audit=<id>`) rend, d'un coup : l'ancre
du jour de l'écriture, la preuve de Merkle qui l'y relie, le **reçu** exact qui a
été soumis au tiers, et la preuve tierce (`publicationProof`, base64). Quatre
gestes, aucun ne dépendant d'ARCOMPT :

1. recalculer le hash de l'écriture depuis son contenu (`computeEntryHash`, la
   sérialisation canonique est dans `packages/ledger/src/hash.ts`) et vérifier
   qu'il est bien la feuille de la preuve, préfixée de `ENTRY:` ;
2. replier la preuve de Merkle sur la racine : à chaque étape,
   `sha256("node:" + gauche + droite)`, les feuilles étant
   `sha256("leaf:" + valeur)` ;
3. vérifier que le reçu contient cette racine, et que son empreinte sha256 est
   celle scellée par le tiers :
   `printf '%s' "<reçu>" | sha256sum` ;
4. vérifier la preuve tierce. Pour `rfc3161` :

   ```bash
   printf '%s' "<reçu>" > recu.txt
   printf '%s' "<publicationProof>" | base64 -d > ancre.tsr
   openssl ts -reply -in ancre.tsr -text            # empreinte et heure attestées
   openssl ts -verify -data recu.txt -in ancre.tsr -CAfile <chaîne de la TSA>
   ```

   Pour `endpoint` : la preuve est un JSON base64 portant la signature Ed25519 du
   reçu et la clé publique ; `openssl pkeyutl -verify -pubin -inkey cle.pem
   -rawin -in recu.txt -sigfile signature.bin`.

`GET /v1/anchors/chain` vérifie l'ensemble d'un dossier et distingue les deux
échecs : `chain` rompu (la table d'ancres a été réécrite) et `tampered` (la
racine d'un jour ne se recalcule plus depuis les données — c'est la
falsification que tout ce dispositif existe pour lever). `unpublished` liste les
ancres qui ne sont jamais sorties : elles ne prouvent rien à un tiers.

Enfin, `ledger_anchor` est immuable par trigger, comme le grand livre :
suppression interdite, contenu figé, et une ancre publiée ne se republie pas. Le
rôle applicatif n'a pas `DELETE` dessus.

## Surveillance

- Journaux structurés JSON sans montants nominatifs ni données de paie ; OpenTelemetry et Sentry sont pris en charge et s'activent en renseignant `OTEL_EXPORTER_OTLP_ENDPOINT` ou `SENTRY_DSN` (chargement dynamique au démarrage, `apps/api/src/telemetry.ts`). Non renseignées, l'API se contente des journaux structurés.
- Alertes de sécurité (`apps/api/src/telemetry.ts`) : rafale d'échecs d'authentification, rejets RLS (403), webhooks invalides ou rejoués, pics d'appels IA, divergences paiements / écritures, limitation de débit. Brancher un `AlertSink` vers l'astreinte.
- Ancrage externe : la tâche `scripts/anchor-daily.mts` sort en code 1 dès qu'une ancre n'est pas sortie de la plateforme — branchez-la sur l'alerte de l'ordonnanceur. Une ancre qui reste `PENDING` ou `FAILED` veut dire que l'engagement n° 10 n'est pas tenu pour cette journée-là, et cela ne se rattrape pas tout seul indéfiniment : la chaîne se construit dans l'ordre.
- Contrôles de cohérence comptable (`GET /v1/anomalies`, contrôles des états) : certains signaux de fraude sont plus visibles dans les chiffres que dans les journaux techniques.

## Revue trimestrielle

Les points 4 et 5 sont outillés ; les autres restent une liste à dérouler à la main.

1. Tests de fuite entre dossiers et contrôle du modèle de droits (`pnpm test:tenancy`, qui couvre `db.test.ts` et `provision.test.ts`) sur la version déployée. Sur la base de production, le même contrôle s'obtient en relançant `scripts/provision-app-role.mts` : il revérifie les 30 droits attendus sans rien changer d'autre que le mot de passe fourni.
2. Revue des droits (`GET /v1/portal/org/entitlement-review`) et suspension des comptes inactifs. Les rôles se lisent et se modifient dans `company_member` depuis le portail, avec effet à la requête suivante.
3. Audit du journal des accès administrateur et des demandes break-glass.
4. Vérification des chaînes de hash et de la chaîne d'ancres. Sur la base en service : `GET /v1/anchors/chain` par dossier (il recalcule chaque racine de Merkle depuis les données du jour, ce que `verifyAnchorChain` seul ne fait pas) et `GET /v1/entries/chain/<journal>`. Sur une copie restaurée, `scripts/restore-drill.mts` fait les deux, plus la piste d'audit et les soldes, et le point 5 est alors couvert par le même passage.
5. Exercice de restauration : `pnpm exec tsx scripts/restore-drill.mts`. Consignez le rapport et la durée — c'est la mesure de RTO réelle.
6. Contrôle de l'ancrage : aucune ancre en `PENDING` ou `FAILED` depuis plus de 48 h (`GET /v1/anchors`), et aucune journée d'activité inancrable signalée par `scripts/anchor-daily.mts`.

## Conformité pays

Avant lancement commercial dans un pays : déclaration ou autorisation auprès de l'autorité de protection des données (hébergement hors territoire), validation du pack pays par l'expert-comptable référent (`packages/country-packs/packs/<code>/README.md`), passage du pack en `PUBLISHED`.
