ARCOMPT

La comptabilité intelligente des PME de l'espace OHADA. ARCOMPT permet à une PME de facturer, encaisser, payer ses salariés et déclarer ses impôts, puis produit automatiquement ses états financiers conformes au SYSCOHADA révisé : bilan, compte de résultat, tableau des flux de trésorerie, notes annexes et liasse fiscale (DSF).

Statut : phases 0 à 3 livrées côté serveur — moteur comptable avec invariants en base, états financiers et rendu PDF/Excel, facturation, achats, trésorerie et rapprochement, paie chiffrée, immobilisations, stocks en inventaire intermittent, fiscalité et DSF, clôture et circuit de visa, capture IA avec file de revue, WhatsApp, portail cabinets, huit packs pays en brouillon. Le web couvre tous les modules (52 pages) avec une PWA hors ligne ; des tests de bout en bout dans Chromium vérifient le parcours PME. Ce qui n'est pas construit — inventaire permanent des stocks, opérateur de paiement réel, connecteur de certification réel, envoi d'e-mails et de SMS, ancrage exécuté, application mobile native — est listé plus bas.

Pourquoi ARCOMPT
Conforme OHADA par construction. Plan de comptes SYSCOHADA, systèmes Normal et SMT, contrôles de cohérence bloquants (actif = passif, résultat bilan = résultat CR, TFT = variation de trésorerie).
Notes annexes automatisées. Le point faible des outils existants : ARCOMPT calcule les notes chiffrées et prépare le brouillon des notes narratives.
Multi-pays sans code spécifique. Un noyau OHADA commun ; TVA, paie, DSF et formats de dépôt DGI vivent dans des « packs pays » versionnés.
IA qui propose, humain qui valide. Saisie par photo ou WhatsApp, catégorisation automatique, assistant en langage naturel. Aucun chiffre publié ne vient de l'IA : les calculs sont déterministes et testés.
Pensé pour le terrain. PWA mobile, tolérante aux coupures réseau, prix en FCFA, encaissement par mobile money.
Portail cabinets. Vue multi-dossiers, file de revue, circuit de visa de l'expert-comptable.
Fonctionnalités
Module	Contenu	Phase
Moteur comptable	Grand livre en partie double, journaux, exercices, inaltérabilité (triggers), piste d'audit, ancrage Merkle conçu et testé mais jamais exécuté	Livré
États financiers	Bilan, compte de résultat, TFT, PDF et Excel, import de balance ; 47 notes annexes définies, dont 35 calculées et rapprochées	Livré
Portail cabinets	Multi-dossiers, file de revue, commentaires, visa, dépôt, facturation cabinet, marque blanche	Livré (API)
Facturation et dépenses	Devis, factures, avoirs, relances, règlements, capture de pièces par IA ; mobile money derrière un opérateur simulé	Livré (API)
Trésorerie	Banque, caisse, mobile money, import de relevés, rapprochement, prévision	Livré (API)
Paie	Bulletins par pack pays, cotisations, livre de paie, déclarations, chiffrement	Livré (API)
Fiscalité	TVA, retenues, acomptes, DSF Excel, calendrier ; facture certifiée en connecteur simulé seulement	Livré (API)
Assistant IA	Questions en langage naturel sur outils typés, anomalies, WhatsApp	Livré (API)
Web	PWA hors ligne, tableau de bord, écritures, états et écrans de tous les modules	Livré
Stack
Brique	Choix
Front	Next.js (React) en PWA, Tailwind CSS, FR / EN
API	Node.js + TypeScript (Hono)
Base de données	PostgreSQL (Neon), Row-Level Security par dossier (pgvector prévu, pas encore utilisé)
ORM	SQL natif (postgres) + Drizzle pour les requêtes applicatives
Tâches de fond	BullMQ + Redis
Fichiers	Cloudflare R2
Authentification	Keycloak (OIDC) authentifie ; rôles par dossier dans company_member ; MFA exigée par l'API quand l'organisation la requiert
IA	API Claude (vision + texte) derrière une passerelle interne
PDF / Excel	Gabarits HTML → PDF (Playwright), ExcelJS
Messagerie	WhatsApp Business API
Observabilité	Journaux structurés ; OpenTelemetry et Sentry pris en charge, activés par variable d'environnement
Prérequis
Node.js 20 ou plus, pnpm 9 ou plus
Docker (PostgreSQL et Redis en local)
Un realm Keycloak de développement
Une clé API Anthropic (fonctions IA ; facultative pour le moteur comptable)
Démarrage rapide
bash
git clone <url-du-depot> arcompt
cd arcompt
pnpm install

cp .env.example .env          # puis renseigner les variables ci-dessous
docker compose up -d          # PostgreSQL + Redis

pnpm db:migrate               # crée le schéma et les contraintes comptables
pnpm db:seed                  # plan de comptes SYSCOHADA + dossier de démonstration

pnpm dev                      # web sur http://localhost:3000, API sur :4000

# En mode AUTH_MODE=dev, l'API accepte les en-têtes X-User-Id et X-Tenant-Id :
curl -H "X-User-Id: demo" -H "X-Tenant-Id: <id du dossier>" \
     "http://localhost:4000/v1/statements?fiscalYear=2025"
Variables d'environnement
Variable	Rôle
DATABASE_URL	Connexion PostgreSQL
REDIS_URL	File de tâches
KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET	Authentification OIDC
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET	Stockage des pièces et exports
ANTHROPIC_API_KEY	Passerelle IA
WHATSAPP_API_URL, WHATSAPP_TOKEN	Canal WhatsApp
PAYMENT_PROVIDER, PAYMENT_API_KEY	Agrégateur mobile money
APP_URL, DEFAULT_LOCALE	URL publique, langue par défaut (fr)

La liste complète, avec l'effet de chaque variable absente, est dans .env.example. En production (NODE_ENV=production), l'API refuse de démarrer tant que les secrets et les connecteurs ne sont pas réels : la validation de démarrage rassemble tous les manques et échoue avec la liste complète, et chaque exception délibérée se pose par une variable d'opt-out explicite.

Ne jamais committer .env. Les secrets de production vivent dans le gestionnaire de secrets de l'hébergeur.

Structure du dépôt
arcompt/
├── apps/
│   ├── web/                  # Next.js : PME, portail cabinets
│   └── api/                  # API, auth, workers
├── packages/
│   ├── ledger/               # Moteur comptable : écritures, invariants, soldes
│   ├── statements/           # Moteur d'états : table de passage, contrôles, rendu
│   ├── rules/                # Interpréteur des règles déclaratives (TVA, paie)
│   ├── country-packs/        # packs/<code ISO>/ : ci, sn, tg, bj, bf, ml, ne, cm
│   ├── ai-gateway/           # Appels modèle, schémas JSON, journalisation
│   ├── db/                   # Schéma, migrations, seeds (plan SYSCOHADA)
│   ├── posting/              # Modèles d'écriture des modules métier
│   ├── invoicing/ treasury/ payroll/ tax/ assets/ closing/   # Modules métier
│   └── documents/ storage/ jobs/ whatsapp/ portal/ render/   # Pièces, IA, fichiers, tâches, canal, portail, rendu
├── fixtures/
│   └── balances/             # Balances de référence + postes attendus (demo-ci)
├── .github/workflows/ci.yml  # lint, typecheck, migrations, tests, build
├── docs/
│   ├── ARCHITECTURE.md  SECURITY.md  MODULES.md  OPERATIONS.md  API.md
│   └── country-packs/
├── docker-compose.yml
└── .env.example
Commandes
Commande	Effet
pnpm dev	Lance web + API en mode développement
pnpm worker	Lance le processus de tâches de fond (extraction IA, WhatsApp, relances)
pnpm build	Build de production
pnpm test	Tests unitaires
pnpm test:statements	Non-régression des états sur les balances de référence
pnpm test:tenancy	Vérifie qu'aucune donnée ne fuit entre dossiers (exige DATABASE_URL)
pnpm test:e2e	Parcours navigateur (Chromium) contre l'API et le web sur une base peuplée
pnpm db:migrate / pnpm db:seed	Schéma et données initiales
pnpm pack:validate <pays>	Valide un pack pays contre son schéma
pnpm lint / pnpm typecheck	Qualité du code
Règles d'or du code
Le grand livre est la seule source de vérité. Aucun module n'écrit en base directement : tout passe par packages/ledger.
Une écriture validée est immuable. On corrige par contrepassation, jamais par UPDATE.
Pas de flottants pour l'argent. NUMERIC(20,4) + code devise.
Aucune logique pays en dur. Tout ce qui varie d'un pays à l'autre va dans packages/country-packs, en données versionnées (valid_from / valid_to).
L'IA ne calcule jamais un état et ne comptabilise rien sans validation humaine.
Tout changement de gabarit d'état passe pnpm test:statements.
Ajouter un pays
Copier packages/country-packs/packs/_template/ vers le code ISO du pays.
Renseigner identité fiscale, TVA, taxes, paie, DSF, format de dépôt et calendrier.
Faire valider les valeurs par un expert-comptable du pays.
Lancer pnpm pack:validate <pays> puis ajouter une balance de référence dans fixtures/.
Ce qui n'est pas encore construit
Inventaire permanent des stocks : non implémenté. Seul l'inventaire intermittent existe (articles, mouvements valorisés en CUMP ou PEPS, inventaire physique, variation 603x / 73x à la clôture) ; aucun écran web, seulement l'API /v1/stock.
Encaissement mobile money : aucun opérateur réel, seul un fournisseur simulé en mémoire.
Facture certifiée (FNE, MECeF…) : aucun connecteur réel, seulement un simulateur.
Envoi d'e-mails et de SMS : aucun expéditeur ; le port de notification du portail journalise et n'envoie rien.
Gestionnaire de clés : la clé maître de paie vient d'une variable d'environnement, aucune implémentation KMS.
Ancrage externe de la chaîne de hash : calcul et preuves écrits et testés, mais jamais appelés ni publiés.
Application mobile native (Expo) et saisie vocale en langues locales : non commencées.
Mémoire sémantique (pgvector) : le chemin vectoriel n'est jamais emprunté, la mémoire des catégorisations est lexicale.
Packs pays : les huit packs sont en brouillon, aucun relu par un expert-comptable.
Séparation des rôles SQL, sauvegardes et exercices de restauration : procédures manuelles, sans outillage dans le dépôt.
Détail et justification : docs/ARCHITECTURE.md (« Ce qui n'est pas encore construit »).

Feuille de route
Phase	Livrable
0. Fondations	Multi-tenant, auth, plan de comptes, moteur comptable, import de balance
1. États financiers	Bilan, CR, TFT, notes annexes, portail cabinets, premier pack pays
2. Gestion quotidienne	Facturation, dépenses, trésorerie, mobile money, capture IA, TVA
3. Paie et fiscalité	Paie par pays, déclarations, DSF, facture certifiée, assistant
4. Extension	Nouveaux pays, zone CEMAC, consolidation, API publique

Détails : docs/ARCHITECTURE.md, docs/SECURITY.md, docs/MODULES.md, docs/country-packs/README.md.

Avertissement

ARCOMPT facilite la tenue comptable et la production des états financiers ; il ne remplace pas l'expert-comptable. Les taux, barèmes et formats des packs pays doivent être validés par un professionnel inscrit à l'ordre du pays concerné avant toute utilisation en production.

Licence

Propriétaire — © ARGILETTE LLC. Tous droits réservés.
