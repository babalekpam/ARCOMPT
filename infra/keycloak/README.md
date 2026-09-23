# Keycloak (développement)

`docker compose --profile auth up -d keycloak` importe le realm `arcompt` depuis `realm-arcompt.json` :

- clients `arcompt-web` (code flow, secret de dev) et `arcompt-api` (bearer only) ;
- deux utilisateurs de démonstration (`comptable` / `comptable`, `dirigeant` / `dirigeant`).

Le realm de développement active le lien « Forgot password » sur la page
Keycloak, mais l'envoi ne fonctionne qu'après configuration du SMTP **dans
Keycloak** (distinct du SMTP de l'application). En production, vérifier le
parcours de récupération chez le fournisseur avant d'ouvrir l'accès aux OWNER.

## Qui fait quoi

**Keycloak authentifie, ARCOMPT autorise.** Le jeton ne sert qu'à prouver l'identité :
l'API vérifie sa signature via le JWKS de `KEYCLOAK_ISSUER`, puis n'en retient que le
sujet (`sub`). Les droits sont ensuite lus dans la base :

| Question | Réponse |
| --- | --- |
| Qui est l'appelant ? | `app_user` dont `keycloak_sub` vaut le `sub` du jeton |
| À quelle organisation appartient-il ? | `app_user.organization_id` |
| Quels dossiers peut-il ouvrir ? | les lignes `company_member` de cet utilisateur |
| Avec quel rôle ? | `company_member.role` du dossier choisi |

La résolution passe par `auth_resolve_identity(sub)` (migration `0009_identity.sql`),
une fonction `SECURITY DEFINER` : `app_user` et `company_member` sont en *FORCE ROW LEVEL
SECURITY* et, à cet instant, aucun contexte tenant n'existe encore — c'est justement ce
que l'on cherche à établir. L'en-tête `X-Tenant-Id` choisit le dossier courant et doit
correspondre à une appartenance ; sinon la requête est refusée (403).

Conséquence pratique : un changement de rôle, un retrait de membre ou la création d'un
dossier depuis le portail prend effet à la requête suivante. **Il n'y a plus rien à
recopier dans Keycloak**, et aucune synchronisation par l'API d'administration Keycloak
n'existe (les variables `KEYCLOAK_ADMIN_*` mentionnées dans d'anciennes notes n'ont
jamais été implémentées et ne sont plus nécessaires).

L'attribut utilisateur `tenants` et le scope `arcompt-tenants` restent présents dans le
realm de développement, mais **l'API les ignore** : ils ne donnent aucun droit.

## Rattachement des comptes : automatique au premier accès

Un compte créé par le portail (invitation) ou par le seed n'a pas encore de
`keycloak_sub`. Il se rattache **tout seul à la première connexion**, à condition que
le jeton porte une adresse de courriel vérifiée (`email_verified`) correspondant à
`app_user.email`. Aucune intervention n'est nécessaire : il suffit que l'adresse dans
Keycloak soit la même que dans ARCOMPT, et qu'elle soit vérifiée.

Le rattachement est volontairement étroit, et refuse plutôt que de deviner :

- courriel non vérifié : jamais de rattachement (sinon s'inscrire avec l'adresse
  d'autrui suffirait à prendre son dossier) ;
- compte déjà rattaché : jamais réécrit par un autre sujet ;
- sujet déjà rattaché : il ne peut pas revendiquer un second compte ;
- plusieurs comptes non rattachés pour la même adresse : refus, l'ambiguïté n'est
  pas tranchée au hasard.

Dans ces cas, ou si l'adresse diffère entre les deux systèmes, le rattachement se fait
à la main :

```sql
UPDATE app_user SET keycloak_sub = '<sub Keycloak>' WHERE email = 'comptable@exemple.ci';
```

Le `sub` se lit dans la console d'administration (onglet *Details* de l'utilisateur, champ
*ID*) ou dans le jeton. Les autres refus possibles, tous en 403 :

- compte suspendu (`app_user.suspended_at`) ;
- aucune ligne `company_member` : l'utilisateur existe mais n'a accès à aucun dossier ;
- `X-Tenant-Id` absent des appartenances ;
- second facteur manquant alors que l'organisation l'exige (voir ci-dessous).

Chaque requête authentifiée met aussi à jour `app_user.last_active_at` (au mieux : un
échec n'interrompt jamais la requête). C'est cette colonne que lit la suspension des
comptes dormants du portail.

## Authentification multifacteur

`organization.mfa_required` est désormais **appliqué par l'API** : quand le drapeau est
vrai (il l'est d'office pour les organisations de type `FIRM`), le jeton doit prouver un
second facteur, sinon la requête est refusée en 403. La preuve acceptée :

- le claim `amr` contient une des valeurs `mfa`, `otp`, `hwk`, `swk` (RFC 8176) ; ou
- le claim `acr` vaut `2` ou plus.

La liste est la constante `MFA_AMR_VALUES` (et le seuil `MFA_MIN_ACR`) dans
`apps/api/src/auth.ts` : c'est le seul endroit à ajuster si le fournisseur d'identité
émet d'autres valeurs.

Côté Keycloak :

1. **Enrôler les utilisateurs.** Le realm de développement active l'action requise
   `CONFIGURE_TOTP` par défaut (`defaultAction: true`) : tout nouvel utilisateur configure
   son TOTP à la première connexion. Pour les utilisateurs déjà importés (les deux comptes
   de démonstration), ajouter l'action requise `Configure OTP` sur leur fiche, ou par
   groupe / rôle en production.
2. **Émettre la preuve dans le jeton.** Keycloak n'émet pas `amr` spontanément. Le plus
   simple est de déclarer une correspondance ACR ↔ niveau d'authentification : régler
   `acr.loa.map` sur le realm ou le client (par exemple `{"otp": 2}`) et poser une
   condition *Conditional - Level of Authentication* dans le flux navigateur, de sorte
   qu'une session passée par OTP porte `acr: 2`. À défaut, un protocol mapper de type
   *hardcoded claim* n'est acceptable qu'en développement, puisqu'il affirmerait un second
   facteur qui n'a pas eu lieu.

Vérification rapide : décoder le jeton (`jwt.io`, ou `Base64` du deuxième segment) et
contrôler la présence de `amr` ou d'un `acr` suffisant avant d'incriminer l'API.

## Production

Ce realm est un realm **de développement** : secrets factices, mots de passe en clair,
HTTP local. Un realm de production se construit à part (secrets gérés hors du dépôt,
redirect URIs réelles, brute force et politique TOTP durcies) ; aucune de ces valeurs
n'est versionnée ici.
