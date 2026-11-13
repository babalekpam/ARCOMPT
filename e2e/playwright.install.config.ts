// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { defineConfig } from "@playwright/test";

/**
 * Configuration dédiée à l'invite d'installation : mêmes conventions que le
 * scénario hors ligne (serveurs démarrés par l'opérateur — API dev-auth sur
 * :4100, web sur :3100 ; en développement la coque se monte avec `?sw=1`).
 * Lancement :
 *   DATABASE_URL=postgres://… npx playwright test -c playwright.install.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: "install-prompt.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    ...(process.env.E2E_CHROME_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROME_PATH } } : {}),
  },
});
