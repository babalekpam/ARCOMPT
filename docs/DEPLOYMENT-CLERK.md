# Déploiement actuel — Replit-managed Clerk

> **État : procédure de contrôle, pas une autorisation de publier.** Les
> contrôles de sécurité non liés à l'identité restent obligatoires. Aucun
> compte OWNER de production ne doit être créé uniquement pour faire passer un
> health-check.

ARCOMPT utilise désormais **Replit-managed Clerk** pour l'identité web et la
récupération de mot de passe. Le navigateur conserve sa session Clerk ; Next.js
obtient côté serveur un jeton court et le transmet au proxy Hono. Le navigateur
ne choisit jamais son utilisateur, son organisation ou son dossier.
Les utilisateurs déjà rattachés à un sujet Keycloak ne sont **pas** rattachés
automatiquement à un nouveau sujet Clerk : leur migration exige une procédure
administrateur vérifiée, pas une réattribution par simple adresse e-mail.

## Variables et contrôle avant publication

Dans l'environnement de production, vérifier sans afficher les valeurs :

- `AUTH_MODE=clerk` ;
- `CLERK_SECRET_KEY` (vérification API, secret) ;
- `CLERK_PUBLISHABLE_KEY` / clé publique exposée au web ;
- le proxy Clerk même origine `/api/__clerk` est inclus dans le build Next.js
  de production ; vérifier après publication que le navigateur l'utilise
  effectivement, et que les cookies de session fonctionnent ;
- `CLERK_AUTHORIZED_PARTIES` contenant l'origine HTTPS canonique, ou `APP_URL`
  correctement configurée ;
- `DATABASE_URL`, migrations, rôle SQL restreint, RLS forcée et toutes les
  autres variables de production. `pnpm preflight` doit être relancé contre la
  base et l'environnement de production ; ses `⚠` et `·` restent à traiter.

Ne remplacez pas ces contrôles par une vérification de clé seule. Une session
Clerk prouve l'identité, tandis que la base ARCOMPT décide des dossiers, rôles,
OWNER, suspension et tenant.

## Vérifications fonctionnelles obligatoires

Avant toute comptabilité réelle, avec un compte de test distinct :

1. créer ou inviter l'utilisateur dans Clerk avec une adresse vérifiée ;
2. vérifier le rattachement au premier accès uniquement pour cette adresse
   vérifiée, sans rattachement par nom ou adresse non vérifiée ;
3. vérifier que le bootstrap du premier OWNER est **administrateur uniquement**,
   ponctuel, confirmé sur la bonne base et ne crée ni données fictives ni
   compte public ;
4. tester la récupération de mot de passe fournie par Clerk ;
5. tester un OWNER dont l'organisation exige la MFA, puis refuser un utilisateur
   sans second facteur ;
6. tester deux tenants : sélection normale, accès autorisé, et refus explicite
   d'un dossier appartenant à un autre tenant ;
7. tester suspension, utilisateur sans appartenance et déconnexion.

Ces tests ne prouvent pas la disponibilité des services de stockage, antivirus,
IA, messagerie, paiements, certification, sauvegardes et restauration : les
gates existants de `preflight` et d'`OPERATIONS.md` restent requis. **ARCOMPT
n'est pas déclarée prête à publier tant que ces exigences live ne sont pas
prouvées.**

## Anciennes procédures

`docs/DEPLOYMENT-REPLIT.md` et `docs/DEPLOYMENT-PACKAGE.md` contiennent des
passages historiques. Toute instruction qui demande Keycloak, Auth.js,
`KEYCLOAK_*` ou `AUTH_SECRET` est **LEGACY — ne pas exécuter pour le
déploiement actuel**. Utilisez cette page et `scripts/preflight.mts` pour
l'identité Clerk ; reportez-vous aux anciennes pages uniquement pour comprendre
un ancien déploiement, une migration ou un incident historique.