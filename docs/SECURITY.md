# Architecture de sécurité

Reprise du document « Security Architecture — Plateforme comptable intelligente OHADA pour PME » (v1.0, septembre 2026), compagnon de `ARCHITECTURE.md`. Chaque section indique ce que le dépôt implémente (**Dans le dépôt**) et ce qui relève de l'exploitation.

## 1. Posture

Trois actifs critiques : l'intégrité comptable (le grand livre est la seule source de vérité ; une écriture falsifiée est une fraude, pas une fuite), la confidentialité des données économiques (soldes, marges, paie, identifiants fiscaux) et la disponibilité avec preuve (conservation 10 ans, AUDCIF).

Objectifs hiérarchisés, ordre non négociable :

| Rang | Objectif | Conséquence d'une violation |
| --- | --- | --- |
| 1 | Intégrité des écritures validées | Fraude, rejet par l'administration, perte des cabinets |
| 2 | Isolation entre dossiers | Contentieux, perte de confiance, fuite fiscale |
| 3 | Traçabilité complète et inviolable | Impossibilité d'auditer, rejet en contrôle fiscal |
| 4 | Disponibilité (RTO 4 h / RPO 15 min) | Clôtures bloquées, pénalités de retard |
| 5 | Confidentialité | Violation des lois sur les données personnelles |
| 6 | Résilience face à l'IA et aux fournisseurs | Écritures hallucinées, dépendance |

Principe directeur : **la base impose, l'application propose**. Toute règle de sécurité exprimable en base (contraintes, triggers, RLS, rôles SQL) l'est.

## 2. Modèle de menace

Adversaires : attaquant opportuniste (rançongiciel, revente), attaquant ciblant une PME ou un cabinet (fraude, espionnage), utilisateur interne malveillant (antidatage, suppression, lectures hors périmètre), fournisseur compromis (IA, agrégateur mobile money, messagerie), acteur étatique.

Scénarios prioritaires :

1. Un compte de dirigeant compromis crée et valide des écritures frauduleuses ou vide la trésorerie via mobile money.
2. Rupture de l'isolation entre dossiers.
3. Webhook de paiement forgé marquant des factures payées sans encaissement.
4. Abus de la couche IA : injection de prompt par pièce jointe, classification forcée vers un compte frauduleux, validation hâtive.
5. Opérateur ou développeur lisant ou modifiant des données client en production sans autorisation.
6. Rançongiciel ou destruction de la base et des sauvegardes avant clôture.
7. Antidatage : insertion dans une période déjà déclarée.

## 3. Défense en profondeur

Aucune couche ne fait confiance à celle du dessus : l'API ne fait pas confiance au client (`tenant_id` vient du jeton), la base ne fait pas confiance à l'API (RLS quelle que soit l'origine), les moteurs de calcul ne font pas confiance aux données (validation de schéma stricte).

| Couche | Contenu |
| --- | --- |
| 7. Gouvernance | Politiques, revues, procédures de crise |
| 6. Application | Autorisation, validation IA, journaux |
| 5. API | Authentification, limitation de débit, schémas |
| 4. Base de données | RLS, contraintes, immutabilité |
| 3. Plateforme | Isolation des conteneurs, secrets, réseau |
| 2. Périmètre | CDN/WAF, TLS, Zero Trust, anti-DDoS |
| 1. Données au repos | Chiffrement, clés, sauvegardes |

## 4. Identités et accès

- Identité centralisée Keycloak (OIDC) ; l'application n'émet aucun jeton.
- MFA obligatoire pour les cabinets, administrateurs, comptes ayant pouvoir de validation ou de paiement (TOTP ou WebAuthn ; pas de SMS).
- Jamais de compte partagé ; comptes de service distincts par service, portée minimale, rotation.
- RBAC par dossier et moindre privilège :

| Rôle | Peut | Ne peut jamais |
| --- | --- | --- |
| Dirigeant (OWNER) | Valider les propositions IA, consulter, approuver les paiements | Modifier une écriture validée, voir la paie des autres |
| Caissier / assistant (CASHIER) | Saisir des brouillons, déposer des pièces | Valider une écriture, approuver un paiement |
| Comptable (ACCOUNTANT) | Tout sauf déverrouiller une période close | S'auto-valider sur ses opérations sensibles |
| Expert-comptable (REVIEWER) | Réviser, viser, soumettre au dépôt | Modifier le grand livre |
| Auditeur (AUDITOR) | Lecture seule, export des journaux | Toute écriture |
| Administrateur plateforme | Support technique, packs pays | Lire le contenu comptable sans journalisation |

- Séparation des tâches : celui qui saisit une facture ne peut seul la valider et enregistrer son paiement ; au-delà d'un seuil, double validation.
- Administrateur neutralisé : aucun droit SQL direct sur les tables comptables ; tout accès à un dossier client notifie le client ; accès d'urgence (break-glass) temporaire, approuvé par un second administrateur, intégralement journalisé.
- Cycle de vie : invitation seule et limitée dans le temps, révocation immédiate (backchannel OIDC), revue trimestrielle des droits, suspension après 90 jours d'inactivité, chaque changement de rôle dans `audit_log`.

**Dans le dépôt.** `apps/api/src/auth.ts` (tenant issu du claim `tenants` du jeton), `requireRole`, realm Keycloak `infra/keycloak` avec MFA. La séparation des tâches et les seuils de double validation sont portés par le module facturation (`payment` approuvé par un utilisateur différent du créateur) ; les notifications d'accès administrateur par le portail.

## 5. Isolation multi-dossiers

RLS PostgreSQL sur `tenant_id` sans exception, contexte fixé par la couche d'authentification et hors de portée des requêtes utilisateur ; aucune requête inter-dossiers légitime en dehors des vues et procédures du portail, elles-mêmes contrôlées ; tests de fuite automatisés bloquants (lecture, modification, insertion vers un dossier étranger par l'API, par SQL applicatif et par chemins indirects) ; environnements physiquement séparés, jamais de copie de données de production en clair.

**Dans le dépôt.** `packages/db/migrations/0001_core.sql` (RLS forcée, rôle `arcompt_app`), `packages/db/src/db.test.ts` et `pnpm test:tenancy`.

## 6. Intégrité et immutabilité du grand livre

Équilibre par trigger différé ; UPDATE/DELETE interdits sur une écriture validée (par les droits et triggers, pas par convention) ; correction par contrepassation liée ; verrouillage des périodes (déverrouillage seulement avec trace complète et approbation) ; chaînage par hash des écritures et du journal d'audit.

Renforcement recommandé : **ancrage externe périodique** — une racine de Merkle des hashes des écritures validées (par dossier et par jour) publiée hors de la plateforme (horodatage qualifié ou registre public immuable). L'immutabilité devient prouvable devant un juge ou un commissaire aux comptes.

**Dans le dépôt.** Triggers de `0001_core.sql`, `Ledger.verifyChain`, `packages/ledger/src/anchoring.ts` (racine de Merkle quotidienne, journal d'ancrage, fournisseur d'ancrage interchangeable).

## 7. Protection des données

- Transit : TLS 1.2+ partout, HSTS, mTLS entre services ; webhooks entrants (mobile money, messagerie) signés, vérifiés, protégés contre le rejeu (nonce/horodatage) ; un webhook invalide est rejeté et journalisé comme tentative d'attaque.
- Repos : chiffrement des volumes et de l'object store par l'hébergeur ; chiffrement applicatif par enveloppe (clés dans un KMS) pour la paie, les identifiants fiscaux des tiers et les coordonnées bancaires ; clés hors base, rotation annuelle, séparées par environnement, jamais dans le code ni les images.
- Minimisation, droit à l'export complet (réversibilité), suppression attestée hors périmètre fiscal.

**Dans le dépôt.** `packages/payroll/src/crypto.ts` (AES-256-GCM, clé injectée par l'environnement, avertissement en dev), vérification HMAC des webhooks dans `packages/invoicing` (paiements) et `packages/whatsapp`, idempotence par identifiant d'événement.

## 8. Sécurité de la couche IA

Passerelle unique (minimisation, schémas JSON stricts, journal complet, quotas, bascule de fournisseur) ; l'IA ne comptabilise jamais (propositions dans un tampon distinct, validation humaine explicite) ; sorties vérifiées contre le référentiel (compte existant, HT + TVA = TTC, période ouverte) ; injection de prompt traitée comme entrée hostile (instructions système épinglées, séparation contenu/instructions, filtrage des motifs d'exfiltration, analyse du type réel des fichiers) ; confidentialité contractuelle envers le fournisseur (aucune donnée d'entraînement, journal de ce qui est envoyé) ; assistant limité à des outils typés en lecture seule sans paramètre tenant.

**Dans le dépôt.** `packages/ai-gateway` (schémas, garde-fous, journal), `packages/documents` (tampon `ai_proposal`, contrôle de période ouverte, contrôle du type réel des fichiers, filtrage d'injection), `ai_call_log` masqué selon la même politique que les journaux.

## 9. Canaux entrants

WhatsApp : numéro vérifié avant traitement, actions sensibles conditionnées à une session authentifiée récente, messages traités comme entrée non fiable. Pièces : type réel vérifié, taille limitée, analyse antivirus, stockage hors du chemin d'exécution (jamais servi depuis l'origine de l'application), hash SHA-256 à l'ingestion. Mobile money : idempotence stricte des callbacks, rapprochement montant attendu / reçu, écarts en file de revue humaine. Imports : même pipeline de validation que la saisie manuelle.

## 10. Sécurité opérationnelle

Zero Trust (mTLS, micro-segmentation), WAF et limitation de débit par IP, compte et point d'accès (endpoint OCR/vision protégé), pas de surface d'administration publique (bastion MFA). Images minimales scannées, dépendances épinglées et auditées, rôle SQL applicatif sans DDL, migrations sous un compte distinct par la CI, secrets injectés au démarrage, détection de secrets dans les journaux (y compris les journaux IA). CI/CD avec revue obligatoire, tests d'isolation et d'invariants bloquants, déploiements signés. Observabilité : journaux structurés sans montants nominatifs hors contexte ni données de paie, OpenTelemetry, Sentry ; alertes temps réel (échecs d'authentification massifs, accès administrateur, tentatives inter-dossiers — un rejet RLS est un signal d'attaque —, webhooks invalides, pics d'appels IA, divergence paiements/écritures). Continuité : RPO ≤ 15 min, RTO ≤ 4 h, pas de maintenance autour des échéances fiscales, sauvegardes chiffrées en seconde région, restauration testée chaque trimestre, PITR, gestion de crise documentée.

**Dans le dépôt.** Limitation de débit et en-têtes de sécurité dans `apps/api/src/security.ts`, alertes de sécurité dans `apps/api/src/telemetry.ts`, images `infra/docker`, workflow CI.

## 11. Mode hors ligne et client léger

Hors ligne = brouillons seulement (jamais de validation, de validation IA ni de paiement) ; stockage IndexedDB chiffré côté navigateur, UUID générés côté client ; tout ce qui compte est attribué par le serveur (numérotation légale, validation, statuts) ; synchronisation idempotente ; jetons courts sur mobile, verrouillage applicatif ; WhatsApp/SMS n'expose jamais d'export de données sensibles.

## 12. Conformité et gouvernance

AUDCIF/OHADA (conservation 10 ans, immutabilité, export complet), lois nationales sur les données personnelles (CI 2013, SN 2008, BJ 2017, TG 2019 : déclarations, registres, hébergement), données de paie en catégorie sensible. Expert-comptable référent par pays validant les packs ; chaque modification de pack versionnée et signée ; revue de sécurité trimestrielle ; audit externe annuel et programme de divulgation responsable.

## 13. Les dix engagements non négociables

1. Le grand livre validé est immuable, par les droits SQL, pas par discipline.
2. Toute anomalie s'exprime par une contrepassation liée et tracée.
3. `tenant_id` vient du jeton ; la RLS est la dernière ligne de défense, prouvée par des tests de fuite bloquants.
4. L'IA ne produit que des propositions ; aucune sortie de modèle ne devient une écriture sans action humaine.
5. Tout accès humain ou machine est unique, protégé par MFA, à moindre privilège et journalisé dans un journal chaîné.
6. Les clés vivent hors de la base, dans un KMS, avec rotation ; le chiffrement applicatif protège la paie et les identifiants fiscaux.
7. Toute action d'administrateur sur un dossier client est visible du client.
8. Les webhooks de paiement sont signés, vérifiés et idempotents.
9. Les sauvegardes sont chiffrées, hors site et restaurées par exercice trimestriel.
10. La chaîne de hash est ancrée hors de la plateforme : l'immutabilité est prouvable.
