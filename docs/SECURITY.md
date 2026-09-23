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

- Identité centralisée Keycloak (OIDC) ; l'application n'émet aucun jeton. **Keycloak authentifie, ARCOMPT autorise** : les dossiers accessibles et les rôles sont lus dans la table `company_member`, et non plus dans un attribut recopié dans le jeton. Un changement fait au portail (rôle modifié, membre retiré, dossier ajouté) prend effet à la requête suivante, sans intervention sur Keycloak.
- MFA : l'API la fait respecter quand l'organisation l'exige (`organization.mfa_required`, vrai par défaut pour les cabinets) ; elle lit les revendications `amr` / `acr` du jeton et refuse celui qui ne prouve pas de second facteur. Elle suppose que le fournisseur d'identité est configuré pour exiger et signaler ce second facteur (TOTP ou WebAuthn ; pas de SMS) : ARCOMPT ne peut que vérifier, pas enrôler. Un compte suspendu ou sans appartenance est refusé avec un motif explicite.
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

**Dans le dépôt.** `apps/api/src/auth.ts` et `apps/api/src/identity.ts` : le jeton n'apporte que le `sub` vérifié, l'identité et les rôles viennent de `auth_resolve_identity()` (migration `0009_identity.sql`, `SECURITY DEFINER` car `app_user` et `company_member` sont en RLS forcée) ; `requireRole` ; realm Keycloak `infra/keycloak`. La séparation des tâches et les seuils de double validation sont portés par le module facturation (`payment` approuvé par un utilisateur différent du créateur) ; les notifications d'accès administrateur par le portail.

## 5. Isolation multi-dossiers

RLS PostgreSQL sur `tenant_id` sans exception, contexte fixé par la couche d'authentification et hors de portée des requêtes utilisateur ; aucune requête inter-dossiers légitime en dehors des vues et procédures du portail, elles-mêmes contrôlées ; tests de fuite automatisés bloquants (lecture, modification, insertion vers un dossier étranger par l'API, par SQL applicatif et par chemins indirects) ; environnements physiquement séparés, jamais de copie de données de production en clair.

**Dans le dépôt.** `packages/db/migrations/0001_core.sql` (RLS forcée, rôle `arcompt_app` — voir § 6 : ce rôle n'est pas encore celui avec lequel l'application se connecte en exploitation), `packages/db/src/db.test.ts` et `pnpm test:tenancy`.

## 6. Intégrité et immutabilité du grand livre

Équilibre par trigger différé ; UPDATE/DELETE interdits sur une écriture validée **par des triggers de base de données**, pas par convention applicative ; correction par contrepassation liée ; verrouillage des périodes (déverrouillage seulement avec trace complète et approbation) ; chaînage par hash des écritures et du journal d'audit.

Renforcement recommandé : **ancrage externe périodique** — une racine de Merkle des hashes des écritures validées (par dossier et par jour) publiée hors de la plateforme (horodatage qualifié ou registre public immuable). L'immutabilité devient prouvable devant un juge ou un commissaire aux comptes. **Ce renforcement est en service** : `packages/ledger/src/anchoring.ts` calcule la racine de Merkle, la chaîne d'ancres et les preuves d'inclusion ; la migration `0013_anchoring.sql` conserve les ancres dans `ledger_anchor` (immuable par trigger, RLS, sans `DELETE` pour le rôle applicatif) ; `scripts/anchor-daily.mts` les produit chaque nuit et les publie ; `Rfc3161AnchorPublisher` les fait horodater par une autorité tierce, `SignedEndpointAnchorPublisher` dépose un reçu signé Ed25519 chez l'exploitant, et `MemoryAnchorPublisher` reste réservé aux tests, refusé en production. L'ancre couvre **les deux** chaînes de hash — écritures validées et journal d'audit —, chaque feuille portant son domaine. `GET /v1/anchors/proof?entry=…` rend l'ancre, la preuve d'inclusion, le reçu scellé et la preuve tierce, qu'un commissaire aux comptes vérifie avec `openssl ts` sans passer par nous. Sans `ANCHOR_PUBLISHER`, la fonction est coupée et annoncée comme dégradée : aucune ancre n'est jamais marquée publiée sans accusé d'un tiers. Mise en œuvre et exercices : `docs/OPERATIONS.md`.

**Dans le dépôt.** Triggers `journal_entry_immutable_trg` et `journal_line_immutable_trg` de `0001_core.sql`, `Ledger.verifyChain`.

**Mécanisme exact, et sa limite.** L'inaltérabilité repose sur les triggers, pas sur les droits SQL : `0001_core.sql` accorde `SELECT, INSERT, UPDATE, DELETE` sur toutes les tables du schéma à `arcompt_app` et ne retire ces droits que sur `audit_log` et `account_balance` — `journal_entry` et `journal_line` restent modifiables du point de vue des privilèges, et ce sont les triggers qui refusent. Le trigger protège donc tout accès SQL, y compris hors application, mais un compte capable de désactiver les triggers (propriétaire du schéma, superutilisateur) n'est arrêté par rien.

**Écart connu — séparation des rôles SQL non livrée.** `arcompt_app` est créé `NOLOGIN` et aucune migration ne crée de rôle de connexion membre de ce rôle ; `docker-compose.yml` et `.env.example` font pointer `DATABASE_URL` sur `arcompt`, le propriétaire du schéma. En l'état, l'application se connecte donc avec le propriétaire, qui peut faire du DDL et désactiver les triggers. Seul le harnais de test crée un rôle de connexion applicatif (`arcompt_app_login`, `packages/db/src/testing.ts`) : la séparation est vérifiée en test mais pas appliquée en exploitation. La corriger suppose de créer ce rôle de connexion, de l'utiliser dans `DATABASE_URL` et de retirer explicitement `UPDATE, DELETE` sur `journal_entry` et `journal_line`.

## 7. Protection des données

- Transit : TLS 1.2+ partout, HSTS, mTLS entre services ; webhooks entrants (mobile money, messagerie) signés, vérifiés, protégés contre le rejeu (nonce/horodatage) ; un webhook invalide est rejeté et journalisé comme tentative d'attaque.
- Repos : chiffrement des volumes et de l'object store par l'hébergeur ; chiffrement applicatif par enveloppe pour la paie, les identifiants fiscaux des tiers et les coordonnées bancaires ; clés hors base, rotation annuelle, séparées par environnement, jamais dans le code ni les images. **Cible ; voir ci-dessous l'écart avec l'implémentation.**
- Minimisation, droit à l'export complet (réversibilité), suppression attestée hors périmètre fiscal.

**Dans le dépôt.** `packages/db/src/crypto.ts` (AES-256-GCM, chiffrement par enveloppe avec clé de données par dossier dans `payroll_tenant_key`, rotation par `PayrollService.rotateTenantKey()`), vérification HMAC des webhooks dans `packages/invoicing` (paiements) et `packages/whatsapp`, idempotence par identifiant d'événement. Le module vivait dans `packages/payroll` ; il est remonté dans `@arcompt/db` — le seul paquet dont dépendent déjà tous les lecteurs et écrivains de ces champs — sans changer une ligne de cryptographie ni le format des chiffrés. `packages/payroll/src/crypto.ts` n'en est plus qu'un ré-export : il n'existe qu'une implémentation.

**Ce qui est réellement chiffré.** Trois champs de paie — `base_salary_enc`, `bank_details_enc`, `social_security_number_enc` (`0005_payroll.sql`) — **et les identifiants fiscaux** : `company.tax_ids_enc`, `partner.tax_id_enc`, `employee.tax_id_enc` (`0011_pack_status_tax_ids.sql`), sous la même clé de données de dossier et la même rotation. Les colonnes en clair d'origine sont conservées le temps de la reprise puis vidées par `scripts/encrypt-tax-ids.mts` (idempotent, rejouable) ; leur suppression est une migration ultérieure.

**Recherche d'un tiers par son identifiant fiscal.** Un chiffré authentifié à IV aléatoire ne se cherche pas au motif : le `partner.tax_id ILIKE '%…%'` de `apps/api/src/routes/partners.ts` est remplacé par un **index aveugle déterministe** `partner.tax_id_bidx` (HMAC-SHA-256 de la valeur normalisée, clé dérivée par HKDF de la clé de données du dossier). La recherche par identifiant devient une égalité sur la valeur entière ; la recherche par nom reste une recherche par fragment. Ce que l'index concède, et rien de plus : l'égalité de deux identifiants au sein d'un même dossier est observable. Sans la clé maître, l'index n'est pas calculable, donc pas testable contre un identifiant candidat, et il est cloisonné par dossier.

**Pas de gestionnaire de clés.** `crypto.ts` définit l'interface `KeyProvider`, mais la seule implémentation livrée est `EnvKeyProvider` : la clé maître vient de la variable `PAYROLL_ENCRYPTION_KEY`. Aucun connecteur KMS (Cloudflare, AWS, Vault…) n'existe dans le dépôt ; « clés dans un KMS » décrit l'exploitation visée, pas le code. La variable doit donc être injectée depuis le gestionnaire de secrets de l'hébergeur et traitée comme telle.

## 8. Sécurité de la couche IA

Passerelle unique (minimisation, schémas JSON stricts, journal complet, quotas, bascule de fournisseur) ; l'IA ne comptabilise jamais (propositions dans un tampon distinct, validation humaine explicite) ; sorties vérifiées contre le référentiel (compte existant, HT + TVA = TTC, période ouverte) ; injection de prompt traitée comme entrée hostile (instructions système épinglées, séparation contenu/instructions, filtrage des motifs d'exfiltration, analyse du type réel des fichiers) ; confidentialité contractuelle envers le fournisseur (aucune donnée d'entraînement, journal de ce qui est envoyé) ; assistant limité à des outils typés en lecture seule sans paramètre tenant.

**Dans le dépôt.** `packages/ai-gateway` (schémas, garde-fous, journal), `packages/documents` (tampon `ai_proposal`, contrôle de période ouverte, contrôle du type réel des fichiers, filtrage d'injection), `ai_call_log` masqué selon la même politique que les journaux.

## 9. Canaux entrants

WhatsApp : numéro vérifié avant traitement, actions sensibles conditionnées à une session authentifiée récente, messages traités comme entrée non fiable. Pièces : type réel vérifié, taille limitée, analyse antivirus, stockage hors du chemin d'exécution (jamais servi depuis l'origine de l'application), hash SHA-256 à l'ingestion. Mobile money : idempotence stricte des callbacks, rapprochement montant attendu / reçu, écarts en file de revue humaine. Imports : même pipeline de validation que la saisie manuelle.

## 10. Sécurité opérationnelle

Zero Trust (mTLS, micro-segmentation), WAF et limitation de débit par IP, compte et point d'accès (endpoint OCR/vision protégé), pas de surface d'administration publique (bastion MFA). Images minimales scannées, dépendances épinglées et auditées, rôle SQL applicatif sans DDL, migrations sous un compte distinct par la CI, secrets injectés au démarrage, détection de secrets dans les journaux (y compris les journaux IA). CI/CD avec revue obligatoire, tests d'isolation et d'invariants bloquants, déploiements signés. Observabilité : journaux structurés sans montants nominatifs hors contexte ni données de paie, OpenTelemetry, Sentry ; alertes temps réel (échecs d'authentification massifs, accès administrateur, tentatives inter-dossiers — un rejet RLS est un signal d'attaque —, webhooks invalides, pics d'appels IA, divergence paiements/écritures). Continuité : RPO ≤ 15 min, RTO ≤ 4 h, pas de maintenance autour des échéances fiscales, sauvegardes chiffrées en seconde région, restauration testée chaque trimestre, PITR, gestion de crise documentée.

**Dans le dépôt.** Limitation de débit et en-têtes de sécurité dans `apps/api/src/security.ts`, journaux structurés masqués et alertes de sécurité dans `apps/api/src/telemetry.ts` (OpenTelemetry et Sentry chargés dynamiquement si `OTEL_EXPORTER_OTLP_ENDPOINT` ou `SENTRY_DSN` est défini), images `infra/docker`, workflow CI.

**Pas encore livré sur ce chapitre.** Le rôle SQL applicatif sans DDL n'est pas appliqué en exploitation (§ 6) ; les sauvegardes chiffrées, la restauration et l'exercice de reprise sont outillés (`scripts/backup.mts`, `scripts/restore.mts`, `scripts/restore-drill.mts`), mais leur ordonnancement, la copie en seconde région et la tenue du registre d'exercices restent des gestes d'exploitation (voir `docs/OPERATIONS.md`) ; aucun `AlertSink` n'est branché par défaut vers une astreinte.

## 11. Mode hors ligne et client léger

Hors ligne = brouillons seulement (jamais de validation, de validation IA ni de paiement) ; stockage IndexedDB chiffré côté navigateur, UUID générés côté client ; tout ce qui compte est attribué par le serveur (numérotation légale, validation, statuts) ; synchronisation idempotente ; jetons courts sur mobile, verrouillage applicatif ; WhatsApp/SMS n'expose jamais d'export de données sensibles.

## 12. Conformité et gouvernance

AUDCIF/OHADA (conservation 10 ans, immutabilité, export complet), lois nationales sur les données personnelles (CI 2013, SN 2008, BJ 2017, TG 2019 : déclarations, registres, hébergement), données de paie en catégorie sensible. Expert-comptable référent par pays validant les packs ; chaque modification de pack versionnée et signée ; revue de sécurité trimestrielle ; audit externe annuel et programme de divulgation responsable.

## 13. Les dix engagements non négociables

La colonne « État » dit ce que le dépôt tient aujourd'hui ; un engagement tenu partiellement est signalé comme tel, il n'est pas retiré.

| # | Engagement | État |
| --- | --- | --- |
| 1 | Le grand livre validé est immuable, par la base et non par discipline. | Tenu par des triggers ; la séparation des rôles SQL qui le compléterait n'est pas livrée (§ 6) |
| 2 | Toute anomalie s'exprime par une contrepassation liée et tracée. | Tenu |
| 3 | Le dossier courant est vérifié côté serveur contre les appartenances de l'utilisateur ; la RLS est la dernière ligne de défense, prouvée par des tests de fuite bloquants. | Tenu (`company_member`, `pnpm test:tenancy`) |
| 4 | L'IA ne produit que des propositions ; aucune sortie de modèle ne devient une écriture sans action humaine. | Tenu |
| 5 | Tout accès humain ou machine est unique, à moindre privilège et journalisé dans un journal chaîné ; la MFA est exigée quand l'organisation la requiert. | Tenu côté API ; dépend d'un fournisseur d'identité configuré pour offrir un second facteur |
| 6 | Les clés vivent hors de la base, avec rotation ; le chiffrement applicatif protège la paie. | Partiel : clé maître en variable d'environnement, pas de KMS ; les identifiants fiscaux ne sont pas chiffrés (§ 7) |
| 7 | Toute action d'administrateur sur un dossier client est visible du client. | Tenu (`admin_access_log`, break-glass) ; l'envoi effectif de la notification suppose un `Notifier`, non livré |
| 8 | Les webhooks de paiement sont signés, vérifiés et idempotents. | Tenu, mais contre un fournisseur simulé : aucun agrégateur réel n'est branché |
| 9 | Les sauvegardes sont chiffrées, hors site et restaurées par exercice trimestriel. | Outillé : `scripts/backup.mts` (AES-256-GCM, manifeste scellé, `--verify`), `scripts/restore.mts` (refuse toute cible non jetable sans double confirmation) et `scripts/restore-drill.mts` (restaure dans une base jetable puis vérifie chaînes de hash, piste d'audit, chaîne d'ancres et soldes). La copie hors site et la périodicité restent des gestes d'exploitation |
| 10 | La chaîne de hash est ancrée hors de la plateforme : l'immutabilité est prouvable. | Tenu quand `ANCHOR_PUBLISHER` est configuré : ancres quotidiennes conservées (`ledger_anchor`, migration 0013), publiées par horodatage RFC 3161 ou dépôt signé, preuves d'inclusion servies par `/v1/anchors`. Variable absente, la fonction est coupée et annoncée, jamais simulée |
