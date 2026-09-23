# Conventions pour les modules métier

Ce guide s'adresse à qui ajoute un module (facturation, trésorerie, paie…). Il décrit les briques existantes et les règles à respecter.

## Règles d'or

1. **Le grand livre est la seule source de vérité.** Un module n'écrit jamais dans `journal_entry` / `journal_line` en SQL : il appelle `Ledger.post()` (brouillon + validation) ou `Ledger.createDraft()` puis `Ledger.validate()`. Correction = `Ledger.reverse()`, jamais d'UPDATE.
2. **Pas de flottants pour l'argent.** `Money` (`@arcompt/ledger`) partout ; en base `numeric(20,4)` lu en chaîne ; jamais `Number()` sur un montant.
3. **Aucune logique pays en dur.** Taux, barèmes, comptes spécifiques viennent du pack (`@arcompt/country-packs`, `loadPack(code)`, `packRules(pack).evaluate(id, date, scope)`, `vatRate(pack, code, date)`).
4. **Le tenant vient du contexte serveur.** Toute requête SQL passe par `withTenant(db, { tenantId, organizationId?, userId? }, tx => …)` (`@arcompt/db`) qui fixe `app.tenant_id` pour la Row-Level Security. Toute table métier porte `tenant_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE`, RLS activée et forcée, politique `tenant_isolation`, `GRANT` au rôle `arcompt_app`.
5. **L'IA propose, l'humain valide.** Une proposition n'atteint le grand livre qu'après `validate` par un utilisateur.
6. **Tout est tracé** : les actions métier importantes appellent `store.appendAudit()` ou insèrent dans `audit_log` via SQL (colonne `hash` calculée par trigger).

## Briques

| Brique | Import | Usage |
| --- | --- | --- |
| Moteur comptable | `import { Ledger, PostgresStore, Money } from "@arcompt/ledger"` | `new Ledger(new PostgresStore(db, { userId, organizationId }), { baseCurrency })`, `ledger.post(actor, { journalCode, date, label, source, reference?, lines: [{ accountNumber, debit?/credit?, partnerId?, label?, vatCode? }] })` |
| Base | `import { createDb, withTenant, migrate } from "@arcompt/db"` ; tests : `import { createTestDatabase } from "@arcompt/db/testing"` ; seed : `seedCompany(db, …)` | Les comptes lettrables (401, 411, 421, 422, 481, 485) exigent `partnerId` (table `partner`). |
| États | `import { computeStatements } from "@arcompt/statements"` | Fonction pure sur une balance (`ledger.trialBalance().rows`). |
| Règles | `import { evalNumber, RuleSet } from "@arcompt/rules"` | Décimaux exacts, `tranche()`. |
| Packs pays | `import { loadPack, packRules, vatRate } from "@arcompt/country-packs"` | Huit packs existent : `ci`, `sn`, `tg`, `bj`, `bf`, `ml`, `ne`, `cm`. Tous en `status: "DRAFT"`, aucun relu par un expert-comptable : valeurs indicatives, jamais de déclaration réelle. |
| IA | `import { AiGateway, DocumentExtractionSchema, checkProposal, routeProposal } from "@arcompt/ai-gateway"` | `MockProvider` en test. |
| API | `apps/api/src/routes/<module>.ts` exporte `<module>Routes(deps: AppDeps)` (Hono). `deps.db` (Sql) et `deps.ledgerFor(auth)` ; `c.get("auth")` donne `{ userId, tenantId, organizationId?, roles }` — le dossier et les rôles viennent de `company_member` (résolution par `apps/api/src/identity.ts`), jamais d'un attribut du jeton : un rôle changé au portail vaut dès la requête suivante ; `requireRole(...)` pour restreindre. Erreurs métier : lever `LedgerError` ou renvoyer `{ error: { code, message } }` avec 400/404/409/422. |

Les connecteurs externes n'existent qu'en simulateur : paiement (`MockPaymentProvider`), facture certifiée (`NullConnector`, `MockFneConnector`), notifications du portail (port `Notifier` sans implémentation par défaut). Un module qui s'appuie dessus doit rester derrière son interface et ne rien présumer d'un opérateur réel. L'inventaire complet est en fin de `ARCHITECTURE.md`.

## Migrations

Un fichier par module dans `packages/db/migrations/`, préfixe réservé :

| Fichier | Module |
| --- | --- |
| `0003_invoicing.sql` | facturation, achats, règlements, tiers étendus |
| `0004_treasury.sql` | comptes de trésorerie, relevés, rapprochement |
| `0005_payroll.sql` | salariés, bulletins, livre de paie |
| `0006_assets_tax.sql` | immobilisations, déclarations fiscales |
| `0007_documents_ai.sql` | pièces, propositions, file de revue, mémoire, WhatsApp |
| `0008_closing_portal.sql` | clôture, workflow d'exercice, commentaires, dépôts, invitations |
| `0009_identity.sql` | résolution d'identité : appartenances et rôles lus dans `company_member` |
| `0014_inventory.sql` | stocks : articles, mouvements valorisés, inventaire physique, variation de clôture |

Modèle de table :

```sql
CREATE TABLE invoice (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  …
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_tenant_idx ON invoice(tenant_id, …);
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice TO arcompt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arcompt_app;
```

## Tests

- Logique de calcul pure : tests unitaires sans base.
- Persistance et écritures : tests d'intégration avec `createTestDatabase()` (base jetable migrée, `db` superuser et `appDb` rôle applicatif). La suite est ignorée sans `DATABASE_URL`. Localement : `DATABASE_URL=postgres://arcompt:arcompt@localhost:5432/arcompt`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` doivent rester verts. `exactOptionalPropertyTypes` est activé : n'assignez pas `undefined` à une propriété optionnelle, utilisez `...(x ? { x } : {})`.

## Style

Code et commentaires en français, identifiants en anglais (`invoice`, `payslip`). Modules ESM (`.js` dans les imports relatifs). Pas de dépendance nouvelle sans raison ; `zod` pour valider les entrées d'API.
