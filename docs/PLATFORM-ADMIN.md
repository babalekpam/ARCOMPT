# Administration de la plateforme

Le privilège **administrateur plateforme** est distinct du rôle `OWNER` d'un
dossier. Une fois connecté avec Clerk et un second facteur, l'administrateur
peut choisir n'importe quel dossier existant dans `/platform`. L'API vérifie
son droit en base, résout l'organisation du dossier sélectionné et lui donne
les permissions `OWNER` **pour cette requête et ce dossier seulement**. Le
navigateur ne peut pas s'accorder ce droit en envoyant un en-tête ou un claim.
Les politiques RLS par dossier et les invariants comptables (écritures
validées, périodes verrouillées, etc.) restent applicables.

Ce droit donne accès aux données financières et de paie de toutes les
entreprises. Ne l'accordez qu'à un compte Clerk **dédié**, distinct des
comptes des clients et des utilisateurs `OWNER`. Le compte est conservé dans
une organisation interne sans dossier, non dans une organisation cliente.
Chaque accès administratif est enregistré avant l'opération dans un journal
append-only. Ce journal enregistre la tentative, pas le résultat HTTP ; les
écritures métier conservent également leurs audits habituels.

## Création et révocation

1. Configurez la MFA dans l'instance Clerk correspondante (Développement ou
   Production). Le titulaire crée son propre compte Clerk dédié, confirme son
   **adresse primaire** et enrôle un second facteur. Le mot de passe est géré
   par Clerk : ne le partagez pas avec l'agent, et ne le mettez ni en base, ni
   dans le code, ni dans une variable d'environnement.
2. Confirmez l'identifiant exact du compte Clerk (`user_…`) par une voie
   administrative. Utilisez l'environnement de la base **et** l'instance Clerk
   correspondants. La commande exige une connexion PostgreSQL privilégiée de
   maintenance, jamais le rôle applicatif `arcompt_app`. Confirmez la base
   cible ; ne copiez pas une commande de développement en production.
3. Depuis un environnement de maintenance autorisé où `DATABASE_URL` et
   `CLERK_SECRET_KEY` sont déjà configurés, prévisualisez l'octroi :

   ```sh
   corepack pnpm exec tsx scripts/platform-admin.mts \
     --action grant --sub 'user_…' --email 'admin@example.com' \
     --operator 'Nom de l opérateur' --reason 'Motif de l octroi'
   ```

   Vérifiez la base affichée. Pour appliquer, relancez **la même commande**
   avec `--apply --confirm-db '<nom exact affiché>'`. La commande vérifie
   auprès de Clerk le sujet, l'adresse primaire vérifiée et l'enrôlement MFA ;
   elle refuse un compte déjà rattaché à un client. Elle ne crée aucun mot de
   passe. Le `--operator` est une identification déclarative pour le journal ;
   l'opérateur de base de données est aussi enregistré.
4. Pour retirer le droit, utilisez `--action revoke --sub 'user_…'` avec
   `--operator`, `--reason` et, après prévisualisation, `--apply --confirm-db`.
   La révocation ne dépend pas de la disponibilité du compte chez Clerk.

Un administrateur sans dossier sélectionné voit `/platform` ; le sélecteur
global lui permet d'ouvrir un dossier. Une fois le dossier choisi, les écrans
et API existants appliquent leurs opérations `OWNER` dans ce seul contexte.
Le privilège n'autorise pas les éditions SQL arbitraires ni la modification
d'écritures validées. La création d'un premier dossier et d'un premier
`OWNER` reste une opération distincte et contrôlée ; l'organisation interne
de la plateforme ne compte pas comme un dossier client.

**État de publication :** aucun privilège réel n'est accordé par l'ajout de
ce code. Le déploiement, la configuration de production, les tests
interactifs Clerk/MFA et la préflight comptable restent obligatoires avant
utilisation sur des données réelles. Voir `docs/DEPLOYMENT-CLERK.md`.