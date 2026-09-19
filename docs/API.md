# Référence de l'API

Toutes les routes sous `/v1` exigent le contexte d'authentification (jeton OIDC Keycloak avec `X-Tenant-Id`, ou en-têtes `X-User-Id` / `X-Tenant-Id` / `X-Organization-Id` en `AUTH_MODE=dev`). Les erreurs sont renvoyées sous la forme `{ "error": { "code", "message", "details" } }`. Les montants sont des chaînes décimales (4 décimales max), jamais des flottants. Limitation de débit : 600 requêtes/min par compte, 60/min sur les points IA, 30/min sur le rendu.

Généré depuis `apps/api/src/routes/*.ts` ; les rôles requis sont indiqués quand la route les restreint.


## Écritures et balance

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| POST | `/v1/entries` | OWNER, ACCOUNTANT, CASHIER |
| POST | `/v1/entries/:id/validate` | OWNER, ACCOUNTANT |
| POST | `/v1/entries/:id/reverse` | OWNER, ACCOUNTANT |
| DELETE | `/v1/entries/:id` | OWNER, ACCOUNTANT, CASHIER |
| GET | `/v1/entries` |  |
| GET | `/v1/entries/fiscal-years` |  |
| GET | `/v1/entries/trial-balance` |  |
| GET | `/v1/entries/chain/:journal` | OWNER, ACCOUNTANT, AUDITOR, REVIEWER |


## Plan de comptes

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/accounts` |  |


## États financiers

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/statements` |  |


## Packs pays

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/packs` |  |
| GET | `/v1/packs/:code` |  |


## Rendu PDF / Excel

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/render/statements.pdf` |  |
| GET | `/v1/render/statements.xlsx` |  |
| GET | `/v1/render/trial-balance.pdf` |  |
| GET | `/v1/render/trial-balance.xlsx` |  |
| GET | `/v1/render/ledger.pdf` |  |
| GET | `/v1/render/ledger.xlsx` |  |


## Facturation, achats, règlements

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/products` |  |
| POST | `/v1/products` | issue |
| GET | `/v1/products/:id` |  |
| PUT | `/v1/products/:id` | issue |
| GET | `/v1/sales` |  |
| POST | `/v1/sales` | write |
| GET | `/v1/sales/:id` |  |
| PUT | `/v1/sales/:id` | write |
| POST | `/v1/sales/:id/issue` | issue |
| POST | `/v1/sales/:id/cancel` | write |
| POST | `/v1/sales/:id/status` | write |
| POST | `/v1/sales/:id/convert` | write |
| POST | `/v1/sales/:id/credit-note` | issue |
| GET | `/v1/sales/:id/pdf-data` |  |
| POST | `/v1/sales/:id/payment-link` | write |
| GET | `/v1/sales/:id/payment-links` |  |
| POST | `/v1/sales/:id/dunning` | write |
| GET | `/v1/purchases` |  |
| POST | `/v1/purchases` | write |
| GET | `/v1/purchases/:id` |  |
| PUT | `/v1/purchases/:id` | write |
| POST | `/v1/purchases/:id/issue` | issue |
| POST | `/v1/purchases/:id/cancel` | write |
| POST | `/v1/purchases/:id/credit-note` | issue |
| GET | `/v1/payments` |  |
| POST | `/v1/payments` | write |
| POST | `/v1/payments/webhook/:provider` |  |
| GET | `/v1/payments/:id` |  |
| POST | `/v1/payments/:id/allocate` | write |
| POST | `/v1/payments/:id/approve` | issue |
| POST | `/v1/payments/:id/reject` | issue |
| GET | `/v1/receivables/aged` |  |
| GET | `/v1/payables/aged` |  |
| GET | `/v1/dunning/overdue` |  |


## Trésorerie

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/treasury/accounts` |  |
| POST | `/v1/treasury/accounts` | manage |
| GET | `/v1/treasury/accounts/:id` |  |
| PATCH | `/v1/treasury/accounts/:id` | manage |
| DELETE | `/v1/treasury/accounts/:id` | manage |
| GET | `/v1/treasury/accounts/:id/statements` |  |
| POST | `/v1/treasury/accounts/:id/statements` |  |
| GET | `/v1/treasury/statements/:id` |  |
| GET | `/v1/treasury/statements/:id/transactions` |  |
| GET | `/v1/treasury/transactions/:id` |  |
| GET | `/v1/treasury/transactions/:id/candidates` |  |
| POST | `/v1/treasury/transactions/:id/match` | manage |
| POST | `/v1/treasury/transactions/:id/unmatch` | manage |
| POST | `/v1/treasury/transactions/:id/ignore` | manage |
| POST | `/v1/treasury/transactions/:id/post` | manage |
| POST | `/v1/treasury/accounts/:id/auto-match` | manage |
| GET | `/v1/treasury/accounts/:id/reconciliation` |  |
| GET | `/v1/treasury/cash/:id/counts` |  |
| POST | `/v1/treasury/cash/:id/count` |  |
| GET | `/v1/treasury/rules` |  |
| POST | `/v1/treasury/rules` | manage |
| DELETE | `/v1/treasury/rules/:id` | manage |
| POST | `/v1/treasury/forecast` |  |


## Paie

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/payroll/employees` |  |
| POST | `/v1/payroll/employees` | OWNER, ACCOUNTANT |
| GET | `/v1/payroll/employees/:id` |  |
| PATCH | `/v1/payroll/employees/:id` | OWNER, ACCOUNTANT |
| DELETE | `/v1/payroll/employees/:id` | OWNER, ACCOUNTANT |
| GET | `/v1/payroll/runs` |  |
| POST | `/v1/payroll/runs` | OWNER, ACCOUNTANT |
| GET | `/v1/payroll/runs/:id` |  |
| POST | `/v1/payroll/runs/:id/compute` | OWNER, ACCOUNTANT |
| POST | `/v1/payroll/runs/:id/validate` | OWNER, ACCOUNTANT |
| POST | `/v1/payroll/runs/:id/pay` | OWNER, ACCOUNTANT, CASHIER |
| GET | `/v1/payroll/runs/:id/payslips` |  |
| GET | `/v1/payroll/payslips/:id` |  |
| GET | `/v1/payroll/book` | OWNER, ACCOUNTANT, AUDITOR, REVIEWER |
| GET | `/v1/payroll/declarations` | OWNER, ACCOUNTANT, AUDITOR, REVIEWER |
| POST | `/v1/payroll/declarations/:id/file` | OWNER, ACCOUNTANT |


## Fiscalité

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/tax/vat/returns` |  |
| POST | `/v1/tax/vat/returns/compute` | OWNER, ACCOUNTANT |
| GET | `/v1/tax/vat/returns/:id` |  |
| POST | `/v1/tax/vat/returns/:id/validate` | OWNER, ACCOUNTANT |
| POST | `/v1/tax/vat/returns/:id/pay` | OWNER, ACCOUNTANT |
| POST | `/v1/tax/vat/returns/:id/file` | OWNER, ACCOUNTANT |
| GET | `/v1/tax/is/instalments` |  |
| POST | `/v1/tax/is/instalments` | OWNER, ACCOUNTANT |
| GET | `/v1/tax/withholding` |  |
| GET | `/v1/tax/dsf/:fiscalYear{.+\\.xlsx}` | OWNER, ACCOUNTANT, REVIEWER, AUDITOR |
| GET | `/v1/tax/dsf/:fiscalYear` | OWNER, ACCOUNTANT, REVIEWER, AUDITOR |
| GET | `/v1/tax/calendar` |  |


## Immobilisations

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/assets` |  |
| POST | `/v1/assets` | OWNER, ACCOUNTANT |
| GET | `/v1/assets/notes` |  |
| POST | `/v1/assets/run-depreciation` | OWNER, ACCOUNTANT |
| GET | `/v1/assets/:id` |  |
| PATCH | `/v1/assets/:id` | OWNER, ACCOUNTANT |
| DELETE | `/v1/assets/:id` | OWNER, ACCOUNTANT |
| GET | `/v1/assets/:id/schedule` |  |
| POST | `/v1/assets/:id/dispose` | OWNER, ACCOUNTANT |


## Clôture et workflow

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/closing/checklist` |  |
| POST | `/v1/closing/checklist` | OWNER, ACCOUNTANT, REVIEWER |
| POST | `/v1/closing/checklist/:id/tick` | OWNER, ACCOUNTANT, REVIEWER |
| GET | `/v1/closing/periods` |  |
| POST | `/v1/closing/periods/:id/close` | OWNER, ACCOUNTANT, REVIEWER |
| POST | `/v1/closing/periods/:id/unlock` | OWNER, REVIEWER |
| GET | `/v1/closing/fiscal-years/:code/workflow` |  |
| POST | `/v1/closing/fiscal-years/:code/workflow` | OWNER, ACCOUNTANT, REVIEWER |
| GET | `/v1/closing/fiscal-years/:code/controls` |  |
| POST | `/v1/closing/fiscal-years/:code/lock` | OWNER, REVIEWER |


## Pièces, IA, assistant

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| POST | `/v1/documents` | OWNER, ACCOUNTANT, CASHIER |
| GET | `/v1/documents/:id` |  |
| GET | `/v1/documents/:id/download` |  |
| POST | `/v1/documents/:id/extract` | OWNER, ACCOUNTANT, CASHIER |
| POST | `/v1/documents/:id/propose` | OWNER, ACCOUNTANT, CASHIER |
| GET | `/v1/proposals` |  |
| POST | `/v1/proposals/bulk-validate` | OWNER, ACCOUNTANT |
| GET | `/v1/proposals/:id` |  |
| POST | `/v1/proposals/:id/validate` | OWNER, ACCOUNTANT |
| POST | `/v1/proposals/:id/correct` | OWNER, ACCOUNTANT |
| POST | `/v1/proposals/:id/reject` | OWNER, ACCOUNTANT |
| POST | `/v1/assistant/ask` |  |
| GET | `/v1/anomalies` | OWNER, ACCOUNTANT, AUDITOR, REVIEWER |


## Portail cabinets

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/v1/portal/org` |  |
| POST | `/v1/portal/org` |  |
| PUT | `/v1/portal/org/mfa` |  |
| GET | `/v1/portal/org/companies` |  |
| POST | `/v1/portal/org/companies` |  |
| GET | `/v1/portal/org/invitations` |  |
| POST | `/v1/portal/org/invitations` |  |
| POST | `/v1/portal/org/invitations/accept` |  |
| GET | `/v1/portal/org/members` |  |
| PUT | `/v1/portal/org/members/:companyId/:userId` |  |
| DELETE | `/v1/portal/org/members/:companyId/:userId` |  |
| POST | `/v1/portal/org/members/suspend-inactive` |  |
| GET | `/v1/portal/org/entitlement-review` |  |
| GET | `/v1/portal/org/dashboard` |  |
| GET | `/v1/portal/org/review-queue` |  |
| GET | `/v1/portal/org/billing` |  |
| GET | `/v1/portal/org/white-label` |  |
| PUT | `/v1/portal/org/white-label` |  |
| GET | `/v1/portal/comments` |  |
| POST | `/v1/portal/comments` |  |
| POST | `/v1/portal/comments/:id/resolve` |  |
| GET | `/v1/portal/missing-documents` |  |
| POST | `/v1/portal/missing-documents` |  |
| POST | `/v1/portal/missing-documents/:id/received` |  |
| GET | `/v1/portal/filings` |  |
| POST | `/v1/portal/filings/prepare` |  |
| POST | `/v1/portal/filings/:id/mark-filed` |  |
| POST | `/v1/portal/filings/:id/attach-receipt` |  |
| GET | `/v1/portal/usage` |  |
| POST | `/v1/portal/usage` |  |
| GET | `/v1/portal/admin-access` |  |
| GET | `/v1/portal/break-glass` |  |


## WhatsApp (sans jeton)

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| GET | `/whatsapp/webhook` |  |
| POST | `/whatsapp/webhook` |  |


## Webhooks de paiement (sans jeton)

| Méthode | Chemin | Rôles |
| --- | --- | --- |
| POST | `/webhooks/payments/:provider/:providerRef` |  |

