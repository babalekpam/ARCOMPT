# Packs pays

Un pays = un pack de données versionné dans `packages/country-packs/packs/<code ISO>/pack.json`. Le noyau OHADA (plan de comptes, états, règles AUDCIF) est commun aux 17 pays ; tout ce qui varie vit dans le pack : identité fiscale, TVA, impôts, paie, DSF, format de dépôt, calendrier, sous-comptes imposés.

Un pack ne contient **jamais de code**. Les calculs sont des expressions déclaratives évaluées par `@arcompt/rules` (`tranche(base, bareme)`, `min`, `max`, `round`, `if`…). Chaque règle porte `valid_from` / `valid_to` : une loi de finances publie une nouvelle version, les périodes déjà déclarées restent calculées avec l'ancienne.

## Structure

| Composant | Contenu |
| --- | --- |
| `identity` | Devise, langues, identifiants fiscaux et leur format (NCC, NINEA, IFU, NIF…), systèmes comptables admis, organisme social, administration fiscale |
| `vat` | Taux (code, taux, comptes 443x / 445x, validité) et règles de liquidation |
| `taxes` | IS / BIC, impôt minimum forfaitaire, retenues à la source, patente : barèmes et seuils datés |
| `payroll` | Cotisations sociales, barème d'impôt sur salaires, plafonds, variables d'entrée |
| `dsf` | États fiscaux annexes propres à la DGI, tableaux de passage résultat comptable → fiscal |
| `filing` | Format et canal de dépôt (e-impôts, e-Bilan, modèle Excel ou XML) ; `api: false` tant qu'aucun portail n'expose d'API |
| `calendar` | Échéances déclaratives |
| `chart_overrides` | Sous-comptes imposés localement |
| `certified_invoice` | Facture normalisée (FNE, MECeF…) : obligation et nom du connecteur ; aucun connecteur réel n'est livré à ce jour, seulement un simulateur |

## Cycle de vie

1. Copier `packs/_template/` vers le code ISO du pays (`sn/`, `tg/`, `bj/`, `bf/`…).
2. Renseigner les composants ; laisser `status: "DRAFT"`.
3. Lancer `pnpm pack:validate <code>` : schéma, chevauchements de validité, dépendances, variables non déclarées.
4. Faire valider chaque valeur par un expert-comptable inscrit à l'ordre du pays ; renseigner `reviewed_by` et passer en `REVIEWED` puis `PUBLISHED`.
5. Ajouter une balance de référence et sa liasse attendue dans `fixtures/balances/` (test de non-régression).
6. Publier : un dossier référence `pack_version` (`ci@2025.1`) ; changer de version est une décision explicite par dossier.

## État réel des packs

Huit packs sont livrés — `ci`, `sn`, `tg`, `bj`, `bf`, `ml`, `ne`, `cm` — plus le gabarit `_template`. **Tous sont en `status: "DRAFT"`**, aucun ne porte de `reviewed_by`, aucun n'est passé en `REVIEWED` ni en `PUBLISHED` : l'étape 4 du cycle de vie n'a été franchie pour aucun pays. Une seule balance de référence existe (`fixtures/balances/demo-ci`), donc l'étape 5 n'est faite que pour la Côte d'Ivoire.

Concrètement : les packs permettent de développer et de tester, pas de déclarer.

## Ordre d'ouverture recommandé

Noyau OHADA d'abord (tenue et états, utilisable partout). Puis packs fiscaux complets par vagues : Côte d'Ivoire et Sénégal ; Togo, Bénin et Burkina ; Mali, Niger et zone CEMAC (XAF, interface EN pour le Cameroun).

## Avertissement

Les taux, barèmes, plafonds, comptes et noms de portails livrés dans ce dépôt sont **indicatifs**. Un pack en `DRAFT` ne doit jamais servir à produire une déclaration réelle.
