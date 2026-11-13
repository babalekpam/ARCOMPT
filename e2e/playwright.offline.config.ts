// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { defineConfig } from "@playwright/test";

/**
 * Configuration dédiée au scénario hors ligne : les serveurs sont démarrés
 * par l'opérateur (API dev-auth sur :4100, web sur :3100) car le service
 * worker n'est actif qu'avec `?sw=1` en développement — voir offline.spec.ts.
 * Lancement :
 *   DATABASE_URL=… pnpm --filter @arcompt/e2e exec playwright test -c playwright.offline.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: "offline.spec.ts",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    // E2E_CHROME_PATH : Chromium déjà présent sur la machine, quand les
    // navigateurs Playwright ne sont pas téléchargés.
    ...(process.env.E2E_CHROME_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROME_PATH } } : {}),
  },
});
