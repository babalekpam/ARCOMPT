ARCOMPT

La comptabilité intelligente des PME de l'espace OHADA. ARCOMPT permet à une PME de facturer, encaisser, payer ses salariés et déclarer ses impôts, puis produit automatiquement ses états financiers conformes au SYSCOHADA révisé : bilan, compte de résultat, tableau des flux de trésorerie, notes annexes et liasse fiscale (DSF).

Statut : phase 0 — fondations livrées (monorepo, schéma PostgreSQL avec invariants et RLS, plan de comptes SYSCOHADA, moteur comptable, import de balance) et moteur d'états de la phase 1 (bilan, compte de résultat, TFT, notes, contrôles). Les modules métier, le portail cabinets et les canaux WhatsApp / mobile money arrivent dans les phases suivantes.

Pourquoi ARCOMPT
Conforme OHADA par construction. Plan de comptes SYSCOHADA, systèmes Normal et SMT, contrôles de cohérence bloquants (actif = passif, résultat bilan = résultat CR, TFT = variation de trésorerie).
Notes annexes automatisées. Le point faible des outils existants : ARCOMPT calcule les notes chiffrées et prépare le brouillon des notes narratives.
Multi-pays sans code spécifique. Un noyau OHADA commun ; TVA, paie, DSF et formats de dépôt DGI vivent dans des « packs pays » versionnés.
IA qui propose, humain qui valide. Saisie par photo ou WhatsApp, catégorisation automatique, assistant en langage naturel. Aucun chiffre publié ne vient de l'IA : les calculs sont déterministes et testés.
Pensé pour le terrain. PWA mobile, tolérante aux coupures réseau, prix en FCFA, encaissement par mobile money.
Portail cabinets. Vue multi-dossiers, file de revue, circuit de visa de l'expert-comptable.
Fonctionnalités
Module	Contenu	Phase
Moteur comptable	Grand livre en partie double, journaux, exercices, inaltérabilité, piste d'audit	0
États financiers	Bilan, compte de résultat, TFT, notes annexes, PDF officiel, import de balance	1
Portail cabinets	Multi-dossiers, révision, visa, dépôt	1
Facturation et dépenses	Devis, factures, avoirs, relances, capture de pièces par IA	2
Trésorerie	Banque, caisse, mobile money, rapprochement, prévision	2
Paie	Bulletins, cotisations sociales par pays, livre de paie	3
Fiscalité	TVA, retenues, acomptes, DSF, facture certifiée (FNE, MECeF…)	3
Assistant IA	Questions en langage naturel, alertes, explication des états	3
Stack
Brique	Choix
Front	Next.js (React) en PWA, Tailwind CSS, FR / EN
API	Node.js + TypeScript (Hono)
Base de données	PostgreSQL (Neon), Row-Level Security par dossier, pgvector
ORM	SQL natif (postgres) + Drizzle pour les requêtes applicatives
Tâches de fond	BullMQ + Redis
Fichiers	Cloudflare R2
Authentification	Keycloak (OIDC), MFA, rôles par dossier
IA	API Claude (vision + texte) derrière une passerelle interne
PDF / Excel	Gabarits HTML → PDF (Playwright), ExcelJS
Messagerie	WhatsApp Business API
Observabilité	OpenTelemetry, Sentry
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
│   ├── country-packs/        # Un dossier par pays : ci/, sn/, tg/, bj/, bf/…
│   ├── ai-gateway/           # Appels modèle, schémas JSON, journalisation
│   ├── db/                   # Schéma, migrations, seeds (plan SYSCOHADA)
│   └── ui/                   # Composants partagés
├── fixtures/
│   └── balances/             # Balances de référence + postes attendus (demo-ci)
├── .github/workflows/ci.yml  # lint, typecheck, migrations, tests, build
├── docs/
│   ├── ARCHITECTURE.md
│   └── country-packs/
├── docker-compose.yml
└── .env.example
Commandes
Commande	Effet
pnpm dev	Lance web + API en mode développement
pnpm build	Build de production
pnpm test	Tests unitaires
pnpm test:statements	Non-régression des états sur les balances de référence
pnpm test:tenancy	Vérifie qu'aucune donnée ne fuit entre dossiers (exige DATABASE_URL)
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
Copier packages/country-packs/_template/ vers le code ISO du pays.
Renseigner identité fiscale, TVA, taxes, paie, DSF, format de dépôt et calendrier.
Faire valider les valeurs par un expert-comptable du pays.
Lancer pnpm pack:validate <pays> puis ajouter une balance de référence dans fixtures/.
Feuille de route
Phase	Livrable
0. Fondations	Multi-tenant, auth, plan de comptes, moteur comptable, import de balance
1. États financiers	Bilan, CR, TFT, notes annexes, portail cabinets, premier pack pays
2. Gestion quotidienne	Facturation, dépenses, trésorerie, mobile money, capture IA, TVA
3. Paie et fiscalité	Paie par pays, déclarations, DSF, facture certifiée, assistant
4. Extension	Nouveaux pays, zone CEMAC, stocks, consolidation, API publique

Détails : docs/ARCHITECTURE.md.

Avertissement

ARCOMPT facilite la tenue comptable et la production des états financiers ; il ne remplace pas l'expert-comptable. Les taux, barèmes et formats des packs pays doivent être validés par un professionnel inscrit à l'ordre du pays concerné avant toute utilisation en production.

Licence

Propriétaire — © ARGILETTE LLC. Tous droits réservés.
