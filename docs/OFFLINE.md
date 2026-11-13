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

Le contrat vaut pour **toutes** les créations que la file peut contenir :
tiers, produits, brouillons de vente et d'achat, écritures — et, depuis la
v5 de la coquille, articles, mouvements et inventaires de stock
(`apps/api/src/routes/stock.ts`). Un mouvement de stock rejoué qui recréerait
sa ligne fausserait l'inventaire en silence : c'était le dernier kind de la
file sans reconnaissance de rejeu côté serveur.

Les pièces justificatives suivent une voie voisine : le serveur les
déduplique par **empreinte du contenu**. Une pièce envoyée deux fois — coupure
en plein envoi, puis rejeu de la file — est reconnue comme doublon et la
pièce existante est renvoyée, jamais un second exemplaire.

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

**Démarrage à froid hors ligne.** Un onglet ouvert sans réseau ne peut pas
récupérer le matériau de session — au départ, il ne voyait donc ni la file ni
la copie locale, alors que tout était sur l'appareil. Désormais, si
l'appareil conserve **exactement** la clé de la dernière session ouverte en
ligne (repère posé en localStorage, effacé à la déconnexion), le coffre se
rouvre avec elle : la file et les copies sont là. Au retour du réseau, avant
tout envoi, la clé est revérifiée contre la session courante ; si elle a
changé, les services sont reconstruits sur la nouvelle et les éléments de
l'ancienne ne sont **jamais** envoyés sous une autre identité. La clé est
liée à l'utilisateur **et** au dossier : se reconnecter avec le même compte
dans le même dossier redonne la même clé, la file survit donc à une session
expirée.

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
- **La première visite exige le réseau.** Créer le compte, se connecter et
  charger l'application une première fois ne se font pas hors ligne ; c'est à
  cette visite que la coquille s'installe et que les copies locales se
  remplissent. Les écrans principaux sont ensuite **réchauffés** (leurs
  morceaux de code sont préchargés en ligne) pour s'ouvrir sans réseau même
  jamais visités.
- **Une pièce hors ligne est plafonnée à 10 Mo en file.** Au-delà, le dépôt
  attend le réseau ; en file, elle part en base64 et le serveur la déduplique
  par empreinte (voir §3).
- **L'installation dépend du navigateur.** Sur Chrome/Edge bureau,
  l'application propose son bouton d'installation dès que le navigateur
  l'autorise ; sur iOS, l'installation passe par Partager → « Sur l'écran
  d'accueil », sans invite programmable. Depuis la v6, l'application ne
  laisse plus l'utilisateur chercher ce bouton : à la première arrivée sur
  le tableau de bord d'un dossier configuré (activation du compte et
  configuration terminées), une carte propose l'installation en un geste —
  ou le mode d'emploi du navigateur détecté, en trois pas, quand il n'y a
  pas d'invite programmable. « Plus tard » la fait taire une semaine, trois
  affichages automatiques au plus, et les réglages gardent une entrée
  manuelle permanente (`lib/install-prompt.ts`,
  `components/pwa/InstallPromptGate.tsx`, `InstallAppCard.tsx`).
- **Une navigation fraîche hors ligne sert l'application.** Un écran
  atteint par la navigation interne n'a pas de document conservé : son
  rechargement sans réseau (et le lancement de l'application installée,
  qui est la même navigation) sert le document exact s'il existe, sinon la
  coquille — le tableau de bord précaché — et le routeur client affiche
  l'écran demandé. La page statique `/offline.html` n'est servie que si
  aucun document de l'application n'est conservé. Défaut constaté en
  conditions réelles le 2026-10-29, corrigé dans le service worker v6 et
  exercé par `lib/sw-worker.test.ts` et `e2e/sw-navigation.spec.ts`.
- **Le cliché de référence se résout tout seul.** Le code du pack venait
  du cliché « pack » lui-même : sur un appareil neuf, le rafraîchissement
  ne partait jamais et le centre de synchronisation affichait « Jamais
  rafraîchi » avec un bouton désactivé. `resolveSnapshotContext` lit le
  cliché d'abord, sinon le profil du dossier (son code pays) : le
  rafraîchissement du premier jour et de chaque retour en ligne part
  réellement.
- **Ce qui reste en ligne, toujours** : l'envoi effectif d'un e-mail ou d'un
  WhatsApp, les fonctions IA (extraction, propositions), la paie et ses
  télétransmissions, et bien sûr les actes refusés du §1.

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
| Clé de session, démarrage à froid, revérification | `apps/web/lib/offline-browser.ts` |
| Rejeu des créations de stock | `apps/api/src/routes/stock.ts` (`stock-idempotency.test.ts`) |
| Dépôt de pièces en file | `apps/web/components/documents/UploadFlow.tsx` |
| Réchauffement de la coquille, invite d'installation | `apps/web/components/pwa/ShellWarmer.tsx`, `InstallAppButton.tsx` |
| Invite du premier jour, capture de l'invite native, report | `apps/web/lib/install-prompt.ts`, `components/pwa/InstallPromptGate.tsx`, `components/pwa/InstallAppCard.tsx` |
| Résolution du contexte du cliché (amorçage) | `apps/web/lib/offline-sync.ts` (`resolveSnapshotContext`, `refreshSnapshotsAuto`) |
| Scénario propriétaire de bout en bout | `e2e/offline.spec.ts` |
| Navigation fraîche hors ligne (coquille, pas page statique) | `e2e/sw-navigation.spec.ts`, `apps/web/lib/sw-worker.test.ts` |
| Invite d'installation : affichage, report, mode installé | `e2e/install-prompt.spec.ts` |

## 9. Exécuter les suites contre le build de production

Les suites Playwright (`e2e/offline.spec.ts`, `sw-navigation.spec.ts`,
`install-prompt.spec.ts`) doivent tourner contre le build de production :
en développement, Next appose un `?v=<horodatage>` par document sur les
chunks, qu'aucun précache ne peut contenir — la page servie hors ligne n'y
hydrate jamais, ce qui ne dit rien du moteur de synchronisation.

Recette locale (machine jetable uniquement) :

1. PostgreSQL local ; base vierge migrée (`pnpm db:migrate`) et amorcée
   (`NODE_ENV=development ALLOW_DEMO_SEED=1 SEED_FIRM=1 pnpm db:seed`) par
   le rôle propriétaire.
2. Créer les rôles de connexion `arcompt_app_login` (membre de
   `arcompt_app`) et `arcompt_queue_login` (membre de `arcompt_queue`) —
   le démarrage de production vérifie les privilèges réels des deux rôles.
3. API : `NODE_ENV=production AUTH_MODE=dev ARCOMPT_E2E_DEV_AUTH=1
   API_PORT=4100 APP_DATABASE_URL=… QUEUE_DATABASE_URL=…
   PAYROLL_ENCRYPTION_KEY=… ALLOW_INSECURE_AI=1 ALLOW_INSECURE_STORAGE=1
   ALLOW_INSECURE_ANTIVIRUS=1 ALLOW_INSECURE_MAIL=1 pnpm --filter
   @arcompt/api start`.
4. Web : `pnpm --filter @arcompt/web build` (clés Clerk factices au format
   `pk_live_`/`sk_live_`), puis `next start -p 3100` avec `AUTH_MODE=dev`,
   `ARCOMPT_E2E_DEV_AUTH=1`, `API_URL=http://localhost:4100`.
5. `DATABASE_URL=… playwright test -c e2e/playwright.offline.config.ts`
   (idem `playwright.sw.config.ts`, `playwright.install.config.ts`).

**`ARCOMPT_E2E_DEV_AUTH=1` ne doit JAMAIS être posée sur un serveur
déployé** : elle autorise `AUTH_MODE=dev` sous `NODE_ENV=production`
(API et web) pour ces seuls tests. Absente — le défaut — le mode dev
reste interdit en production, exactement comme avant. Son activation est
annoncée au démarrage de l'API dans les fonctions dégradées. Avant tout
déploiement, vérifier qu'elle n'apparaît pas dans l'environnement du
serveur (`/opt/arcompt/oracle.env`).

État au 2026-10-29 (build de production, machine locale) :
`sw-navigation` 1/1 et `install-prompt` 4/4 au vert. Le scénario
propriétaire hydrate et met en file hors ligne (deux brouillons en
attente visibles dans la coque), mais échoue après l'enregistrement du
devis hors ligne : le navigateur aboutit sur l'URL `/sync` en affichant
le tableau de bord (document coquille) au lieu de la fiche du devis ou
du centre de synchronisation — la navigation qui suit une mise en file
hors ligne reste un point ouvert, la suite s'arrête là.

Résolution (2026-10-29, SW v7) — le point ouvert ci-dessus est clos, et
le scénario propriétaire passe désormais de bout en bout (les trois
suites au vert contre le build de production). Cause racine, en deux
moitiés :

1. **Le service worker détruisait ce que l'installation avait
   précaché.** Les écrans de l'application lisent les cookies (langue,
   session) : Next les sert « Cache-Control: private, no-store ». À
   chaque navigation document en ligne, `navigationResponse` traitait
   cette politique en `cache.delete(request)` — la visite en ligne de
   `/sync` (étape « visites en ligne » du scénario) supprimait donc le
   document `/sync` précaché à l'installation. Après l'enregistrement
   hors ligne d'un devis, le routeur client aboutit à `/sync` ; faute de
   document exact, le repli « coquille » servait le document du tableau
   de bord à l'adresse `/sync` (celui de `/dashboard` avait survécu par
   accident : visité avec `?sw=1`, autre clé de cache). `sw-navigation`
   ne voyait pas le défaut : `/sync` n'y était atteint qu'en navigation
   interne, sans chargement de document, donc sans suppression. Correctif
   v7 : une réponse que la politique interdit de conserver est servie
   telle quelle et le cache n'est pas touché — en ligne rien ne change
   (réseau d'abord), hors ligne le document précaché reste le filet.
   Cas couvert par `lib/sw-worker.test.ts` (le harnais sert désormais
   les documents avec la politique réelle « private, no-store »).
2. **Le scénario décrivait le flux en ligne, pas le flux hors ligne.**
   Après un enregistrement EN LIGNE, le formulaire mène à la fiche
   `/invoices/<id>` ; hors ligne, le produit mène délibérément à
   `/sync` (« on emmène l'utilisateur là où il peut le voir ») — la
   fiche est rendue côté serveur à partir de l'API et ne peut pas
   exister pour un brouillon encore en file. Le scénario attend
   désormais `/sync` et sa file visible. Trois autres dérives du
   scénario par rapport aux contrats réels ont été corrigées au même
   passage : les enveloppes de réponse (`/partners` rend
   `{ partners: [...] }`, `/entries` rend `{ entries: [...] }`, `/sales`
   un tableau nu — l'ancien lecteur ne déballait que `{ items }` et a
   « vu » un tiers au départ puis aucun après synchronisation, alors
   même que le serveur avait tout accepté dès le retour du réseau) ;
   la preuve « exactement une fois » des écritures passe par l'écran
   « Écritures récentes » (le seul qui montre les brouillons :
   `GET /entries` ne rend que les écritures validées, par conception,
   et la liste récente est alimentée par la réponse du serveur au
   rejeu) ; le rejeu d'idempotence répond 200 et non 201 (contrat écrit
   dans routes/partners.ts) ; et le dépôt de pièce suit l'UI réelle
   (lien « Déposer une pièce », confirmation « Pièce conservée sur cet
   appareil ») avec une preuve par les propositions, tous statuts —
   l'API n'expose pas `GET /documents`, la liste des pièces en est
   dérivée.
