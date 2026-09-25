// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { defineConfig } from "vitest/config";

// Vitest 4 loads multi-project suites from test.projects, not the legacy
// vitest.workspace.ts discovery convention.
export default defineConfig({ test: { projects: [
  { test: { name: "ledger", root: "packages/ledger", include: ["src/**/*.test.ts"] } },
  { test: { name: "statements", root: "packages/statements", include: ["src/**/*.test.ts"] } },
  { test: { name: "rules", root: "packages/rules", include: ["src/**/*.test.ts"] } },
  { test: { name: "country-packs", root: "packages/country-packs", include: ["src/**/*.test.ts"] } },
  { test: { name: "ai-gateway", root: "packages/ai-gateway", include: ["src/**/*.test.ts"] } },
  { test: { name: "db", root: "packages/db", include: ["src/**/*.test.ts"], testTimeout: 30000 } },
  { test: { name: "posting", root: "packages/posting", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "invoicing", root: "packages/invoicing", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "treasury", root: "packages/treasury", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "payroll", root: "packages/payroll", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "tax", root: "packages/tax", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "assets", root: "packages/assets", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "closing", root: "packages/closing", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "documents", root: "packages/documents", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "storage", root: "packages/storage", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "mailer", root: "packages/mailer", include: ["src/**/*.test.ts"] } },
  { test: { name: "jobs", root: "packages/jobs", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "render", root: "packages/render", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "portal", root: "packages/portal", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "whatsapp", root: "packages/whatsapp", include: ["src/**/*.test.ts"], testTimeout: 60000 } },
  { test: { name: "api", root: "apps/api", include: ["src/**/*.test.ts"] } },
  // Scripts d'exploitation (sauvegarde chiffrée, garde-fou de restauration) :
  // du code que l'on n'exécute qu'un jour de panne, donc à couvrir en continu.
  { test: { name: "scripts", root: "scripts", include: ["**/*.test.mts"] } },
  "apps/web/vitest.config.ts",
] } });
