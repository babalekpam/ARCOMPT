# Architecture technique — Plateforme comptable intelligente OHADA pour PME

Version de référence : document d'architecture du 18 septembre 2026. Ce fichier en reprend le contenu et indique, section par section, ce que le dépôt implémente (« **Dans le dépôt** »).

## 1. Vision et principes

La plateforme est un « QuickBooks OHADA » : la PME facture, encaisse et paie ses salariés, et les états financiers SYSCOHADA sortent automatiquement. Six principes guident toute l'architecture.

1. **Le grand livre est la seule source de vérité.** Facturation, paie, banque et IA ne font que produire des écritures en partie double. Les états financiers se calculent uniquement depuis le grand livre.
2. **Noyau OHADA commun, pays en configuration.** Le plan de comptes, les états et les règles AUDCIF sont identiques dans les 17 pays. Tout ce qui varie (TVA, DSF, paie, format de dépôt) vit dans un « pack pays » versionné, sans code spécifique.
3. **L'IA propose, l'humain valide.** Aucune écriture générée par l'IA n'est comptabilisée sans validation. Chaque proposition porte un score de confiance et sa justification.
4. **Déterministe pour les chiffres, probabiliste pour la saisie.** Les calculs (TVA, paie, états) sont du code testé. L'IA sert à lire des pièces, catégoriser et expliquer, jamais à calculer un état.
5. **Inaltérable et auditable.** Une écriture validée ne se modifie pas, elle se contrepasse. Chaque action est tracée.
6. **Conçu pour le terrain.** Mobile d'abord, tolérant aux coupures réseau, WhatsApp comme canal de saisie, prix en FCFA, paiement par mobile money.

## 2. Vue d'ensemble du système

Un monolithe modulaire derrière une seule API : quatre modules métier alimentent le moteur comptable, qui alimente le moteur d'états. La couche IA et les packs pays sont transverses.

```mermaid
flowchart TD
  A[Web PWA] --> G[API + Auth]
  B[Mobile] --> G
  C[WhatsApp] --> G
  G --> F[Facturation]
  G --> T[Trésorerie<br/>banque + mobile money]
  G --> P[Paie]
  G --> X[Fiscalité]
  F --> L[Moteur comptable<br/>grand livre]
  T --> L
  P --> L
  X --> L
  L --> E[Moteur d'états<br/>bilan, CR, TFT, notes]
  E --> D[Exports<br/>PDF, DSF, portails DGI]
  I[Couche IA] -.-> G
  K[Packs pays] -.-> L
  K -.-> E
```

| Couche | Rôle | Ne fait jamais |
| --- | --- | --- |
| Clients | Saisie, consultation, validation | De calcul comptable |
| Modules métier | Factures, encaissements, bulletins, déclarations | D'écriture directe en base : ils passent par le moteur comptable |
| Moteur comptable | Valide et enregistre les écritures, tient les soldes | De logique pays en dur |
| Moteur d'états | Balance → postes → états + contrôles | De modification du grand livre |
| Packs pays | Taux, barèmes, modèles DSF, formats de dépôt | De code exécutable : données et règles déclaratives seulement |
| Couche IA | Lecture de pièces, propositions, assistant | De comptabilisation sans validation humaine |

**Dans le dépôt.** `packages/ledger` (moteur comptable), `packages/statements` (moteur d'états), `packages/rules` + `packages/country-packs` (packs pays), `packages/ai-gateway` (couche IA), `apps/api` (API + auth), `apps/web` (PWA). Les modules métier sont en place — `packages/invoicing` (facturation et achats), `packages/treasury`, `packages/payroll`, `packages/tax`, `packages/assets`, `packages/closing`, via `packages/posting` — et n'écrivent qu'à travers `Ledger.createDraft` / `Ledger.post`. Les stocks sont dans `packages/invoicing/src/stock` (voir § 7).

## 3. Stack technique

TypeScript de bout en bout sur PostgreSQL, en réutilisant l'infrastructure ARGILETTE existante (Neon, Cloudflare, Keycloak).

| Brique | Choix | Pourquoi |
| --- | --- | --- |
| Front web | Next.js (React) en PWA, Tailwind | Installable sur mobile, cache hors ligne, FR/EN |
| Mobile | PWA d'abord, puis React Native (Expo) | Évite deux bases de code au MVP |
| API | Node.js + TypeScript (Hono) | Modules clairs, typage partagé avec le front |
| Base de données | PostgreSQL (Neon), Row-Level Security par tenant | ACID, contraintes, isolation multi-tenant dans la base |
| Montants | NUMERIC(20,4) + code devise, jamais de flottants | XOF/XAF sans décimales, mais GNF, CDF, EUR et USD à gérer |
| ORM | SQL natif via `postgres` (+ Drizzle pour les requêtes applicatives) | Les agrégations comptables restent en SQL |
| Files de tâches | BullMQ + Redis | OCR, génération de liasse, imports, relances |
| Fichiers | Cloudflare R2 | Pièces justificatives, PDF, exports DSF |
| Auth | Keycloak (OIDC) pour l'authentification, rôles par dossier dans `company_member`, MFA exigée par l'API selon l'organisation | Gère cabinets multi-dossiers |
| IA | API Claude (vision + texte) derrière une passerelle interne | Lecture de pièces en français, catégorisation, assistant |
| Recherche sémantique | pgvector dans PostgreSQL | Mémoire des catégorisations passées (cible ; voir § 8 : non active) |
| PDF / Excel | Gabarits HTML → PDF (Playwright), ExcelJS | Modèles officiels, fichiers DSF Excel |
| WhatsApp / SMS | WhatsApp Business API via Twilio ou 360dialog | Canal de saisie et de relance |
| E-mail | Relais SMTP, fournisseur indifférent (`SMTP_*`, `MAIL_*`) | Invitations, demandes de pièces, notifications d'accès, relances |
| Paiements | Agrégateur mobile money (IAPAY, CinetPay, PayDunya, Flutterwave) | Encaissement de factures et abonnements |
| Observabilité | Journaux structurés ; OpenTelemetry et Sentry pris en charge, activés par variable d'environnement | Traçabilité des calculs et des appels IA |

**Hébergement.** Cloudflare en façade (CDN, WAF), application sur conteneurs, base Neon en région Europe. À vérifier par pays : certaines lois de protection des données (Sénégal, Côte d'Ivoire, Bénin) exigent une déclaration ou autorisation pour l'hébergement hors du territoire.

**Dans le dépôt.** `Money` (`packages/ledger/src/money.ts`) : bigint à 4 décimales, jamais de flottant ; `NUMERIC(20,4)` en base ; les valeurs NUMERIC sont lues en chaînes. L'API est en Hono (routes Next.js + tRPC restent possibles côté front).

État des briques d'infrastructure :

- **BullMQ + Redis** : branché (`packages/jobs`, adaptateur BullMQ si `REDIS_URL`, sinon exécution en processus).
- **Cloudflare R2** : branché (`packages/storage/src/r2.ts` via l'API S3 ; repli sur disque local par `STORAGE_DIR`).
- **WhatsApp** : branché (`packages/whatsapp`, fournisseur Meta Cloud API `meta-cloud.ts` et webhook signé).
- **E-mail** : branché (`packages/mailer`, transport SMTP sur nodemailer, modèles français dans `templates.ts`). Aucun fournisseur n'est nommé par le code : `SMTP_*` et `MAIL_*` suffisent à en changer. Sans eux, l'expéditeur est neutre (rien ne part, tout est journalisé) et la production refuse de démarrer, sauf `ALLOW_INSECURE_MAIL=1`. L'envoi depuis un domaine suppose ses enregistrements SPF et DKIM (voir `docs/OPERATIONS.md`).
- **Paiements mobile money** : **pas d'agrégateur réel**. Seul `MockPaymentProvider` (`packages/invoicing/src/payment-provider.ts`) existe : les liens de paiement sont gardés en mémoire et les webhooks signés avec un secret local. `PAYMENT_PROVIDER` / `PAYMENT_API_KEY` ne sont donc consommés par aucun connecteur ; brancher IAPAY, CinetPay, PayDunya ou Flutterwave reste à faire.
- **Recherche sémantique** : la colonne `embedding` (pgvector) et le chemin de recherche vectorielle existent (`packages/documents/src/memory.ts`), mais aucun embedding n'est calculé nulle part dans le dépôt et le seul appelant (`categorize.ts`) n'en passe jamais : le repli lexical (jetons Jaccard + trigrammes Dice) est toujours le chemin exécuté.
- **Observabilité** : journaux structurés masqués (`apps/api/src/telemetry.ts`) ; OpenTelemetry et Sentry sont chargés dynamiquement et uniquement si `OTEL_EXPORTER_OTLP_ENDPOINT` ou `SENTRY_DSN` est défini.

## 4. Modèle de données comptable

Toute la plateforme repose sur deux tables, `journal_entry` et `journal_line`, protégées par des contraintes en base. Chaque ligne porte un `tenant_id` et la Row-Level Security empêche toute fuite entre dossiers.

| Table | Contenu | Règles clés |
| --- | --- | --- |
| `organization` | Cabinet ou groupe qui détient plusieurs dossiers | Porte l'abonnement et les utilisateurs |
| `company` (tenant) | La PME : pays, devise, régime fiscal, système (Normal / SMT), identifiants fiscaux | Référence un pack pays et sa version |
| `fiscal_year`, `period` | Exercices et périodes mensuelles | États : ouvert, clôturé, verrouillé |
| `account` | Plan de comptes : numéro, libellé, classe 1–9, nature, lettrable | Gabarit SYSCOHADA copié à la création ; sous-comptes libres, racines OHADA imposées |
| `journal` | Achats, ventes, banque, caisse, paie, OD, à-nouveaux | Numérotation continue par journal |
| `journal_entry` | En-tête : date, journal, pièce, libellé, statut, source | Brouillon → validé ; validé = immuable |
| `journal_line` | Compte, tiers, débit, crédit, devise, taux, axe analytique, code TVA | Débit ou crédit, jamais les deux ; somme débits = somme crédits |
| `partner` | Clients, fournisseurs, salariés, État | Compte collectif 401 / 411 / 421 rattaché |
| `document` | Pièce justificative (R2), hash SHA-256, données extraites | Liée à l'écriture ; conservation 10 ans (AUDCIF) |
| `reconciliation` | Lettrage et rapprochement bancaire | Lie des `journal_line` entre elles |
| `fixed_asset` | Immobilisations, plan d'amortissement | Génère les dotations ; alimente les notes annexes |
| `stock_article`, `stock_movement` | Articles stockés et mouvements valorisés (CUMP ou PEPS) | Quantités et valeurs seulement : aucun mouvement n'est comptabilisé (inventaire intermittent) |
| `stock_count`, `stock_closing` | Inventaire physique valorisé et variation de fin d'exercice | La clôture produit les écritures 603x / 73x ; une seule par exercice |
| `audit_log` | Qui, quoi, quand, avant / après | Insertion seule, chaîné par hash |

**Invariants garantis par la base, pas par l'application** (`packages/db/migrations/0001_core.sql`) :

- Équilibre : un trigger de contrainte différé refuse toute écriture dont débits ≠ crédits.
- Inaltérabilité : UPDATE et DELETE interdits sur une écriture validée et ses lignes ; la correction passe par une contrepassation liée (`reverses_entry_id` / `reversed_by_entry_id`, posé une seule fois).
- Période verrouillée : aucune insertion ni validation dans une période clôturée.
- Chaînage : chaque écriture validée stocke le hash de la précédente du journal ; le trigger vérifie la continuité de numérotation et du chaînage, l'application vérifie le contenu (`Ledger.verifyChain`).
- Isolation : RLS forcée sur toutes les tables métier ; le tenant vient de `app.tenant_id`, fixé par l'API depuis le jeton.

**Performance.** `account_balance` (compte × période) est tenue à jour à la validation par un trigger `SECURITY DEFINER` ; le rôle applicatif n'y écrit jamais directement.

**Import.** `planBalanceImport` / `importBalance` reprennent une balance (Excel, Sage 100, Perfecto) avec table de correspondance des comptes, exclusion des comptes de gestion et écriture d'à-nouveaux équilibrée dans le journal AN.

## 5. Moteur d'états financiers

Les états sont décrits en données, pas en code : chaque poste du bilan, du compte de résultat ou du TFT est une formule sur des racines de comptes (`packages/statements/src/templates/syscohada-revise/`).

```mermaid
flowchart LR
  A[Grand livre] --> B[Balance<br/>N et N-1]
  B --> C[Table de passage<br/>comptes vers postes]
  C --> D[Calcul des postes]
  D --> E[Contrôles<br/>de cohérence]
  E --> F[Rendu<br/>PDF, Excel, XML]
  E --> G[Anomalies<br/>à corriger]
```

Le pipeline est une fonction pure (`computeStatements`) : même balance et même version de gabarit donnent toujours les mêmes états.

Définition d'un poste, exemple pour le bilan actif, ligne BI « Clients » :

```json
{ "code": "BI", "label": "Clients", "note": 7, "brut": ["+41:D"], "amort_prov": ["+491:C"] }
```

Le suffixe `:D` ou `:C` ne retient que les soldes débiteurs ou créditeurs, par compte de dernier niveau. Cela gère le client créditeur qui doit passer au passif. Deux suffixes de mouvement (`:DM`, `:CM`) servent au tableau des flux (remboursements, sorties d'immobilisations).

| État | Système Normal | SMT | Source |
| --- | --- | --- | --- |
| Bilan (actif / passif) | Oui | Simplifié | Soldes de clôture, classes 1–5 |
| Compte de résultat | Oui, avec soldes intermédiaires | Recettes / dépenses | Classes 6, 7, 8 |
| Tableau des flux de trésorerie | Oui | Non | Variations N / N-1 + retraitements (CAFG, cessions) |
| Notes annexes (47 notes définies, environ 36 au référentiel) | Oui, les 47 | 4 notes essentielles (2, 7, 17, 35) | Grand livre + modules |
| Liasse fiscale (DSF) | Selon pays | Selon pays | États OHADA + états fiscaux du pack pays |

**Notes annexes : le différenciateur.** Trois familles : notes chiffrées dérivées du grand livre (calculées, rapprochées de leur poste), notes alimentées par un module (immobilisations, paie), notes narratives (brouillon IA à valider, jamais exporté sans relecture).

**Couverture réelle.** Le référentiel SYSCOHADA révisé compte environ 36 notes ; `packages/statements/src/templates/syscohada-revise/notes.ts` en définit **47** : 1, 2, 3A, 3B, 3C, 3D, 3E, 4, 5, 6, 7, 8, 8A, 9, 10, 11, 12, 12B, 13, 14, 14B, 15, 16A, 16B, 16C, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27A, 27B, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37. Le compte dépasse 36 parce que les sous-notes comptent séparément et que six numéros (8A, 12B, 14B, 16C, 36, 37) ont été ajoutés pour porter des informations exigées sans poste dédié : dépréciations de l'actif circulant, transferts de charges, variation des capitaux propres, échéancier des créances et des dettes, engagements hors bilan, parties liées.

**35 notes sont calculées** depuis la balance et rapprochées d'un ou de plusieurs postes ; **12 exigent une saisie** parce que l'information n'est pas dans le grand livre et n'est donc pas dérivée : sûretés réelles (1), règles et méthodes (2), contrats de location-acquisition (3B), nature des mouvements de capitaux propres (14B), engagements de retraite (16B), échéances des créances et des dettes (16C), effectifs (27B), cinq derniers exercices et affectation du résultat (31), ratios de synthèse (34), événements postérieurs (35), engagements hors bilan (36), parties liées (37). Elles sortent au statut `DRAFT_REQUIRED`, sans aucun montant, avec la trame de ce qu'il faut fournir.

**Encore indicatif.** Les numéros de notes, leurs intitulés et la table de passage comptes → lignes sont indicatifs, au même titre que les taux des packs pays : un expert-comptable inscrit dans le pays de dépôt doit les confronter au formulaire officiel de la liasse avant tout dépôt réel.

**Contrôles bloquants** : total actif = total passif ; résultat du bilan = résultat du compte de résultat ; variation de trésorerie du TFT = trésorerie nette N − N-1 ; aucun solde orphelin ; total de chaque note chiffrée = poste (ou somme de postes) correspondant, un contrôle par note. **Alertes non bloquantes** : caisse créditrice, compte d'attente 47 non soldé, TVA de sens inhabituel, capitaux propres inférieurs à la moitié du capital (AUSCGIE).

**Tests.** `fixtures/balances/demo-ci/` contient une balance de référence sur deux exercices, produite par le moteur comptable, avec les postes attendus vérifiés à la main ; `pnpm test:statements` la rejoue. Les balances réelles validées par un expert-comptable s'ajoutent au même endroit.

## 6. Couche multi-pays

Un pays = un pack de données versionné, chargé au démarrage et référencé par chaque dossier. Voir `docs/country-packs/README.md`. Chaque règle porte `valid_from` / `valid_to`. Les calculs (TVA, retenues, paie) sont des expressions déclaratives évaluées par l'interpréteur unique `@arcompt/rules` (`tranche(base_imposable, bareme_its)`) ; un pack ne contient jamais de code arbitraire.

Dépôt électronique : aucun portail DGI n'expose d'API publique connue. La cible est de générer le fichier au format exact attendu par le portail, puis de guider le dépôt.

## 7. Modules opérationnels

Chaque module émet des événements métier qu'un « posting engine » transforme en écritures selon des modèles paramétrés. Le dirigeant de PME ne voit jamais un débit ou un crédit ; le comptable voit tout.

| Module | Fonctions | Écritures générées |
| --- | --- | --- |
| Facturation | Devis, factures, avoirs, relances, numérotation légale, lien de paiement mobile money | 411 à 701–706 et 443 |
| Achats et dépenses | Factures fournisseurs, notes de frais, capture par photo | 60x–63x et 445 à 401 |
| Trésorerie | Comptes banque, caisse et mobile money, prévision à 13 semaines | 521 / 571 / 5381 |
| Rapprochement | Import de relevés (CSV, PDF, SMS mobile money), appariement automatique | Lettrage 411 / 401, frais bancaires 631 |
| Paie | Salariés, bulletins, cotisations, livre de paie, déclarations sociales | 661 / 664 à 422, 431, 447 |
| Fiscalité | TVA périodique, retenues, acomptes IS, DSF annuelle | Liquidation 443 / 445 à 444 |
| Immobilisations | Fiche, plan d'amortissement, cessions | 681 à 28x ; alimente les notes annexes |
| Stocks | Articles, mouvements valorisés (CUMP ou PEPS), inventaire physique, variation de clôture | 603x / 73x à 31x–38x |

Ces modules existent tous dans le dépôt (voir le tableau d'état d'implémentation). Les stocks sont tenus en **inventaire intermittent**, la méthode qu'applique la quasi-totalité des PME de l'espace OHADA : les achats vont en charges (601, 602, 604…) au fil de l'exercice, les mouvements de stock sont suivis en quantité et en valeur sans être comptabilisés, et seule la clôture passe deux écritures par le moteur d'imputation — annulation du stock initial (603x/73x à 3xx) puis constatation du stock final inventorié (3xx à 603x/73x). L'**inventaire permanent** (une écriture par mouvement) n'est pas implémenté. Aucun écran web n'existe encore : le module est exposé par l'API (`/v1/stock/...`).

Facture électronique certifiée (FNE en Côte d'Ivoire, MECeF au Bénin…) : connecteur de certification par pays prévu dès la conception (`certified_invoice` dans le pack). Aucun connecteur réel n'est livré : `packages/invoicing/src/certification.ts` ne contient que `NullConnector` et `MockFneConnector` (simulateur activé par `CERTIFICATION_CONNECTOR=mock`). Banque et mobile money : API des agrégateurs, import de relevés lus par l'IA, puis partenariats bancaires directs — l'import et le rapprochement sont livrés, la connexion aux agrégateurs ne l'est pas. Clôture assistée : liste de contrôle mensuelle et annuelle puis verrouillage de la période.

## 8. Couche IA

L'IA supprime la saisie, pas le comptable.

```mermaid
flowchart LR
  A[Photo, PDF<br/>ou WhatsApp] --> B[Extraction<br/>modèle vision]
  B --> C[Proposition d'écriture<br/>+ score de confiance]
  C --> D{Confiance<br/>élevée ?}
  D -- oui --> E[Validation<br/>en un geste]
  D -- non --> F[File de revue<br/>du comptable]
  E --> G[Grand livre]
  F --> G
  G --> H[Mémoire<br/>des corrections]
  H --> C
```

| Capacité | Fonctionnement | Garde-fou |
| --- | --- | --- |
| Capture de pièces | Extraction en JSON strict (`DocumentExtractionSchema`) | Contrôle HT + TVA = TTC ; doublon par hash et par (tiers, montant, date) |
| Catégorisation | Règles du dossier, puis plus proches voisins (aujourd'hui lexicaux ; pgvector prévu), puis LLM avec le plan en contexte | Le compte proposé doit exister dans le plan ; sinon rejet |
| Rapprochement bancaire | Appariement par montant, date, libellé ; LLM pour les libellés ambigus | Jamais de lettrage automatique sous un seuil de confiance |
| Assistant | Appels d'outils typés en lecture seule | Pas de SQL libre ; filtré par tenant côté serveur |
| Notes narratives | Brouillon à partir des données | Marqué « à valider », jamais exporté sans relecture |
| Détection d'anomalies | Règles + écarts statistiques | Alerte seulement, aucune correction automatique |

**Mémoire des catégorisations : état réel.** La recherche de plus proches voisins de `CategorizationMemoryStore.nearest()` n'emprunte le chemin pgvector que si un embedding lui est passé et si la colonne `embedding` existe. Le seul appelant (`packages/documents/src/categorize.ts`) n'en passe pas, et rien dans le dépôt ne calcule d'embedding : **la mémoire fonctionne uniquement par similarité lexicale** (jetons Jaccard, trigrammes Dice, tiers pondéré plus fort que le libellé). La recherche sémantique reste une cible, pas une fonction livrée.

**Passerelle IA interne** (`packages/ai-gateway`) : un seul service encapsule les appels au modèle (minimisation des données, sorties JSON validées par schéma, journal de chaque appel dans `ai_call_log`, quotas par abonnement, fournisseur interchangeable).

## 9. Sécurité, conformité et mode hors ligne

| Domaine | Mesure |
| --- | --- |
| Isolation | RLS PostgreSQL sur `tenant_id` ; le dossier courant est vérifié contre les appartenances de l'utilisateur, jamais accepté sur parole du client ; `pnpm test:tenancy` vérifie l'absence de fuite |
| Accès | Keycloak authentifie (OIDC) ; ARCOMPT autorise à partir de la table `company_member` : rôles par dossier (dirigeant, comptable, caissier, auditeur en lecture seule) modifiables depuis le portail avec effet immédiat. MFA exigée par l'API quand `organization.mfa_required` est vrai — le fournisseur d'identité doit être configuré pour proposer un second facteur |
| Chiffrement | TLS partout ; chiffrement au repos ; champs sensibles de paie chiffrés au niveau applicatif |
| Piste d'audit | `audit_log` en insertion seule, chaîné par hash ; export pour commissaire aux comptes |
| Conservation | Pièces et livres conservés 10 ans (AUDCIF) ; export complet du dossier à tout moment |
| Données personnelles | Lois nationales (CI 2013, SN 2008, BJ 2017, TG 2019) : déclarations, DPA, registre des traitements |
| Sauvegardes | Restauration à un instant donné (Neon), copies chiffrées dans une seconde région, test trimestriel |
| IA | Aucune donnée client utilisée pour entraîner un modèle tiers ; minimisation ; journal des appels |

**Hors ligne.** PWA avec cache applicatif ; saisie hors ligne limitée aux brouillons (IndexedDB, UUID côté client) ; synchronisation par file idempotente (`clientId` sur `journal_entry`) ; numérotation légale et validation attribuées uniquement par le serveur ; WhatsApp et SMS en canal de secours.

## 10. Portail cabinets d'expertise comptable

Tableau de bord multi-dossiers, file de revue des propositions IA, collaboration (demande de pièce par WhatsApp, commentaires), marque blanche et tarification cabinet.

```mermaid
stateDiagram-v2
  [*] --> Tenue
  Tenue --> Revision: clôture demandée
  Revision --> Tenue: corrections
  Revision --> Etats: contrôles OK
  Etats --> Visa: soumis à l'expert
  Visa --> Revision: rejet
  Visa --> Depot: visé et signé
  Depot --> Verrouille: accusé DGI joint
  Verrouille --> [*]
```

L'exercice se verrouille seulement une fois l'accusé de dépôt joint au dossier.

## 11. Feuille de route et risques

| Phase | Durée indicative | Livrable | Client cible |
| --- | --- | --- | --- |
| 0. Fondations | 4–6 semaines | Multi-tenant, auth, plan de comptes OHADA, moteur comptable avec invariants, import de balance | Interne |
| 1. États financiers | 8–10 semaines | Bilan, compte de résultat, TFT, notes annexes, contrôles, PDF officiel, portail cabinets, premier pack pays | Cabinets comptables |
| 2. Gestion quotidienne | 10–12 semaines | Facturation, dépenses, trésorerie, mobile money, rapprochement, capture IA, TVA | PME en direct |
| 3. Paie et fiscalité complète | 10–12 semaines | Paie par pays, déclarations, DSF, facture certifiée, assistant | PME + cabinets |
| 4. Extension | Continu | Nouveaux packs pays, zone CEMAC, consolidation, SYCEBNL, API publique | Groupes, ONG |

**Où en est-on.** Les livrables des phases 0 à 3 sont dans le dépôt, à trois réserves près : les connecteurs externes (paiement, certification, portails DGI) sont simulés, les packs pays restent en brouillon, et les notes annexes, désormais complètes en structure, gardent une numérotation et une table de passage indicatives, non validées par un professionnel inscrit. La phase 4 n'est pas commencée. Le détail est dans « Ce qui n'est pas encore construit », en fin de document.

| Risque | Impact | Parade |
| --- | --- | --- |
| Erreur dans un état ou une déclaration | Perte de confiance immédiate des cabinets | Expert-comptable référent par pays, balances de référence en tests, contrôles bloquants |
| Charge de maintenance des packs pays | Lois de finances annuelles | Packs en données versionnées, veille confiée à des cabinets partenaires |
| Pas d'API bancaire ni DGI | Alimentation et dépôt manuels | Lecture IA des relevés, fichiers au format portail, partenariats progressifs |
| Hallucination de l'IA | Écritures fausses | Validation humaine, schémas stricts, comptes contrôlés contre le plan, scores de confiance |
| Adoption par des PME peu formées | Abandon après essai | WhatsApp, interface sans jargon, cabinet comme accompagnateur |
| Périmètre trop large dès le départ | Retard, rien de fini | États financiers d'abord, le reste ensuite |

**À vérifier avant de figer.** Les numéros de comptes, références de postes, taux et noms de portails cités ici et dans le code sont indicatifs. Ils doivent être validés contre le texte officiel du SYSCOHADA révisé et les codes des impôts de chaque pays par l'expert-comptable référent.

## État d'implémentation

| Bloc | Paquets et fichiers | Statut |
| --- | --- | --- |
| Monorepo, outillage, CI | `package.json`, `vitest.workspace.ts`, `.github/workflows/ci.yml`, `infra/` | Fait |
| Schéma et invariants | `packages/db/migrations/0001…0009`, tests `db` | Fait, testé contre PostgreSQL (RLS, triggers, chaînage) |
| Plan de comptes SYSCOHADA | `packages/db/src/chart.ts` | Fait (indicatif) |
| Moteur comptable | `packages/ledger` | Fait : brouillon/validation, contrepassation, chaînage, balance, import. Ancrage Merkle : code écrit et testé unitairement, mais jamais appelé ni publié (voir « Ce qui n'est pas encore construit ») |
| Moteur d'états | `packages/statements` | Fait : bilan, CR, TFT, 47 notes annexes, contrôles, fixture de référence |
| Rendu PDF / Excel | `packages/render` | Fait : états, balance, grand livre, facture, bulletin, rapprochement ; Chromium + ExcelJS |
| Règles et packs pays | `packages/rules`, `packages/country-packs` | Fait : 8 packs (CI, SN, TG, BJ, BF, ML, NE, CM), tous en `status: "DRAFT"`, aucun relu par un expert-comptable |
| Posting engine | `packages/posting` | Fait : modèles paramétrés pour tous les événements métier |
| Facturation et achats | `packages/invoicing` | Fait : devis, factures, avoirs, numérotation légale, règlements avec séparation des tâches, liens et webhooks mobile money signés et idempotents, balances âgées, relances. Certification et paiement : interfaces en place, connecteurs simulés seulement |
| Trésorerie | `packages/treasury` | Fait : comptes, import CSV/SMS, rapprochement automatique borné, LLM sur ambiguïtés, caisse, prévision 13 semaines |
| Paie | `packages/payroll` | Fait : salariés chiffrés (enveloppe, rotation), bulletins par pack, livre de paie, déclarations, écritures |
| Immobilisations | `packages/assets` | Fait : plans linéaire/dégressif, dotations idempotentes, cessions, notes 3A/3C |
| Stocks | `packages/invoicing/src/stock`, migration `0014_inventory.sql`, routes `/v1/stock` | Fait : articles (unité, CUMP ou PEPS), mouvements valorisés en bigint, inventaire physique et écart, variation de clôture par le posting engine. Inventaire intermittent seulement ; aucun écran web |
| Fiscalité | `packages/tax` | Fait : TVA périodique et liquidation, acomptes IS/IMF, retenues, DSF Excel, calendrier |
| Clôture et workflow | `packages/closing` | Fait : listes de contrôle, clôture bloquée par les contrôles, déverrouillage approuvé, circuit tenue → révision → états → visa → dépôt → verrouillé |
| Pièces, IA, assistant | `packages/documents`, `packages/storage`, `packages/jobs` | Fait : capture, extraction, propositions en tampon, file de revue, mémoire des corrections, assistant à outils typés, anomalies |
| WhatsApp | `packages/whatsapp` | Fait : webhook signé, photo → proposition avec boutons, dépenses par texte, vérification du numéro |
| Portail cabinets | `packages/portal` | Fait : organisation, invitations, tableau de bord multi-dossiers, file de revue, commentaires, pièces manquantes, dépôts, facturation dégressive, marque blanche, accès administrateur notifié, break-glass |
| API | `apps/api` | Fait : auth dev/OIDC avec autorisation lue dans `company_member`, limitation de débit, en-têtes, journaux structurés et alertes, tous les modules montés, webhooks publics, worker de tâches |
| Web | `apps/web` | Fait : auth Keycloak + dev, proxy, i18n FR/EN, PWA hors ligne chiffrée (manifeste, service worker, page hors ligne), et les écrans de tous les modules (facturation, achats, règlements, trésorerie, paie, fiscalité, immobilisations, clôture, pièces et IA, assistant, portail cabinets) ; 52 pages (`find apps/web/app -name page.tsx`) |
| Tests de bout en bout | `e2e/` | Fait : parcours PME dans Chromium (connexion, écrans, facture, PDF, refus d'écriture déséquilibrée), exécuté en CI |
| Mobile natif (Expo), vocal en langues locales, connecteurs DGI et opérateurs réels | — | Non commencé. Les interfaces (certification, paiement, ancrage) existent, avec des simulateurs derrière |

### Ce qui n'est pas encore construit

Liste tenue à jour volontairement : tout ce qui est décrit plus haut comme cible et qui n'a pas d'implémentation réelle dans le dépôt.

| Sujet | État réel |
| --- | --- |
| Inventaire permanent des stocks | Non implémenté : seul l'inventaire intermittent existe. `stock_movement.entry_id` est prévu mais reste toujours NULL |
| Écrans web des stocks | Aucun : le module n'est accessible que par l'API `/v1/stock` |
| Encaissement mobile money | Aucun agrégateur réel ; seul `MockPaymentProvider` (liens en mémoire, webhooks signés localement) |
| Facture certifiée (FNE, MECeF…) | Aucun connecteur réel ; `NullConnector` et `MockFneConnector` seulement |
| Envoi de SMS | Aucun expéditeur : le canal `SMS` d'une relance est refusé, jamais simulé. `packages/treasury/src/sms.ts` **lit** des SMS mobile money, il n'en envoie pas |
| Gestionnaire de clés (KMS) | Interface `KeyProvider` présente, mais seule `EnvKeyProvider` est livrée : la clé maître vient de l'environnement |
| Ancrage externe de la chaîne de hash | Racine de Merkle et preuves d'inclusion écrites et testées (`packages/ledger/src/anchoring.ts`), mais aucun appelant, aucune table d'ancre en migration et un seul publieur, `MemoryAnchorPublisher`, qui garde tout en mémoire. Rien n'est publié à ce jour |
| Recherche sémantique (pgvector) | Chemin vectoriel présent mais jamais emprunté : aucun embedding n'est calculé. La mémoire des catégorisations est lexicale |
| Notes annexes | 47 notes définies (35 calculées, 12 en attente de saisie) ; numéros, intitulés et table de passage indicatifs, non validés par un professionnel inscrit |
| Application mobile native (Expo) | Non commencée ; seule la PWA existe |
| Saisie vocale en langues locales | Non commencée |
| Packs pays | 8 packs, tous en `DRAFT`, aucun `reviewed_by`, aucun publié ; une seule balance de référence (`fixtures/balances/demo-ci`) |
| Séparation des rôles SQL en exploitation | `arcompt_app` est créé `NOLOGIN` et aucune migration ne crée de rôle de connexion membre de ce rôle : hors tests, l'application se connecte avec le propriétaire du schéma (voir `docs/SECURITY.md` § 6) |
| Sauvegardes, restaurations et exercices de reprise | Procédures décrites dans `docs/OPERATIONS.md`, mais aucun script ni automatisation dans le dépôt |
