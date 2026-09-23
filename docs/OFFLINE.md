# Travailler hors ligne

> Signé ARGILETTE. Ce document dit ce que la plateforme fait sans réseau, ce
> qu'elle refuse de faire, et pourquoi la seconde liste ne peut pas être vide.

## 1. La demande, et la réponse honnête

La demande était : « que la plateforme fonctionne hors ligne comme en ligne ».

La moitié de cette phrase est tenue à la lettre : **tout ce qui est saisie**
fonctionne sans réseau, exactement comme avec. L'autre moitié ne peut pas
l'être, et il vaut mieux le dire ici que le découvrir devant un contrôleur.

Certains actes comptables portent un **numéro légal séquentiel** ou un **effet
extérieur** :

| Acte | Ce qui l'empêche |
|---|---|
| Valider une écriture | Le numéro de pièce est séquentiel et sans trou par journal et par exercice. Deux appareils hors ligne attribueraient le même. |
| Émettre une facture | Même numérotation, plus la certification fiscale (FNE, MECeF) qui exige un aller-retour avec l'administration. |
| Encaisser un règlement | L'argent bouge chez un opérateur, pas dans l'application. |
| Déposer une déclaration | Le dépôt est un échange avec le téléservice. |
| Clôturer un exercice | Le verrou de période doit valoir pour tous les utilisateurs au même instant. |

Un appareil hors ligne qui « validerait » une écriture ne validerait rien : il
promettrait un numéro qu'il n'a pas le droit de donner. La plateforme **refuse**
ces actes hors ligne plutôt que de les mettre en file — une file qui contient
une promesse intenable est pire qu'un refus.

Tout le reste se fait hors ligne, et c'est l'essentiel du travail quotidien.

## 2. Ce qui fonctionne sans réseau

### Saisir

| Opération | Devient |
|---|---|
| Écriture comptable | Brouillon, mis en file, validé plus tard par une personne |
| Tiers (client, fournisseur, salarié) | Créé, avec un identifiant **local** utilisable tout de suite |
| Produit du catalogue | Créé |
| Devis, facture, avoir (vente) | **Brouillon** — l'émission, elle, attend le réseau |
| Facture fournisseur, note de frais | Brouillon |
| Article de stock | Créé |
| Mouvement de stock (entrée, sortie) | Enregistré |
| Inventaire physique | Enregistré |
| Photo d'une pièce justificative | Conservée, envoyée au retour du réseau |

### Consulter

Le plan de comptes, les tiers, les produits, les articles de stock, les
exercices et le pack pays sont conservés dans une **copie locale chiffrée**,
rafraîchie à chaque passage en ligne. Sans elle, saisir hors ligne serait
impossible : on ne facture pas un client qu'on ne peut pas désigner.

Ce qui n'est **pas** conservé, délibérément : la balance, le grand livre, les
états financiers, la paie. Ces documents se lisent à une date d'arrêté ; en
servir une copie de trois jours sans le dire ferait décider sur des chiffres
faux. L'écran annonce la coupure et n'invente rien.

## 3. Comment un doublon est évité

C'est le problème central, et il n'est pas celui qu'on croit. La coupure franche
est facile : l'appareil sait qu'il est hors ligne. La coupure **en cours
d'envoi** est le cas difficile — la requête part, le réseau tombe, et personne
ne sait si le serveur a écrit.

Chaque saisie tire donc un **identifiant de rejeu** (`clientId`) *avant* de
partir. Il part avec la requête, et il repart avec le rejeu. Le serveur tient un
registre (`idempotency_record`, migration 0015) :

- identifiant inconnu → l'opération s'exécute, la réponse est conservée ;
- identifiant connu, **même** saisie → la réponse conservée est renvoyée, rien
  ne s'exécute (`Idempotent-Replay: true`, statut 200 au lieu de 201) ;
- identifiant connu, saisie **différente** → 409. Servir l'ancienne réponse
  ferait croire que la nouvelle saisie est enregistrée alors qu'elle est perdue.

Le registre est cloisonné par dossier, immuable une fois complété, et ne
s'efface pas avant sept jours — le temps qu'un appareil resté hors ligne
revienne.

## 4. Comment une facture désigne un client créé hors ligne

Une facture saisie à 10 h 05 peut viser un client créé à 10 h 03, sans réseau
entre les deux. Ce client n'a pas encore d'identifiant serveur.

L'appareil lui en attribue un **local** (`local:<uuid>`). La facture part avec
cette référence. Au rejeu, la file envoie le client d'abord (elle rejoue dans
l'ordre de création), retient l'identifiant serveur qu'elle reçoit, puis
substitue la référence dans la facture.

Si le client est **refusé** par le serveur, la facture n'est pas envoyée : elle
passe en « en attente d'un autre élément ». Elle n'est jamais envoyée avec une
référence inventée, ni avec le texte `local:…` que le serveur prendrait pour un
identifiant invalide.

## 5. Ce que l'utilisateur voit

L'écran **Synchronisation** (`/sync`) distingue trois états, parce qu'ils
appellent trois gestes différents :

- **En attente d'envoi** — rien à faire, le réseau manque.
- **En attente d'un autre élément** — partira seul une fois sa dépendance
  acceptée.
- **Refusé par le serveur** — le seul qui demande une décision humaine. Le
  serveur a dit non sur le fond ; cet élément ne partira jamais tout seul.

Une file invisible est une file où l'on perd des choses. Le compteur du bandeau
et le nombre d'éléments refusés sont des liens vers cet écran.

## 6. Ce qui est chiffré, et avec quoi

Tout ce que l'appareil conserve — file d'opérations, copie locale, historique
récent, table des identifiants locaux — est chiffré en **AES-256-GCM** avec une
clé dérivée par HKDF du matériau de session, **non extractable**, conservée dans
IndexedDB. Un appareil perdu ne rend rien de lisible sans une session valide.

Le changement de session change la clé : les données de l'ancienne deviennent
illisibles. Elles ne sont pas effacées en silence — l'écran de synchronisation
les montre comme illisibles, pour que personne ne croie sa saisie envoyée.

## 7. Limites connues, dites ici plutôt que découvertes

- **Un brouillon de vente hors ligne n'a pas de numéro.** Il en recevra un à
  l'émission, qui reste un acte en ligne. Un client qui attend sa facture sur
  place attendra le réseau.
- **La recherche de tiers hors ligne porte sur le nom seulement.** L'identifiant
  fiscal est cherché par index aveugle, que l'appareil ne sait pas calculer sans
  la clé du dossier.
- **La copie locale peut être incomplète** : un jeu refusé par les droits du
  rôle est simplement absent. L'écran le dit.
- **Le service worker ne rejoue aucune mutation.** Il ne met en cache que des
  lectures. Rejouer un POST depuis un service worker le ferait sans identifiant
  de rejeu ni ordre : c'est la file qui s'en charge, et elle seule.
- **Deux appareils hors ligne ne se voient pas.** Deux comptables qui saisissent
  le même achat sans réseau créeront deux brouillons. Le rapprochement se fait à
  la validation, par une personne — c'est aussi ce que faisait le papier.

## 8. Où c'est écrit dans le code

| Rôle | Fichier |
|---|---|
| Chiffrement, stores IndexedDB, file historique | `apps/web/lib/offline.ts` |
| File d'opérations, références locales | `apps/web/lib/offline-queue.ts` |
| Copie locale des données de référence | `apps/web/lib/offline-snapshot.ts` |
| Rejeu (un seul chemin, partagé) | `apps/web/lib/offline-sync.ts` |
| Créer en ligne ou mettre en file | `apps/web/lib/offline-submit.ts` |
| Écran de synchronisation | `apps/web/components/pwa/SyncCenter.tsx` |
| Coque et caches | `apps/web/public/sw.js` |
| Registre de rejeu, côté serveur | `apps/api/src/idempotency.ts`, `packages/db/migrations/0015_idempotency.sql` |
