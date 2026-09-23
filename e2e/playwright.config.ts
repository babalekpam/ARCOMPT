// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Tests de bout en bout : API + web contre une base PostgreSQL migrée et
 * peuplée (`pnpm db:migrate && SEED_FIRM=1 pnpm db:seed`). Chromium est
 * celui de l'environnement (CHROMIUM_PATH ou /opt/pw-browsers/chromium).
 */
const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3100);
// Chromium de l'environnement si présent (CHROMIUM_PATH ou /opt/pw-browsers), sinon celui installé par Playwright.
const candidate = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const chromium = existsSync(candidate) ? candidate : undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./global-setup.ts",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${webPort}`,
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `AUTH_MODE=dev API_PORT=${apiPort} pnpm --filter @arcompt/api start`,
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: "..",
    },
    {
      command: `AUTH_MODE=dev API_URL=http://localhost:${apiPort} pnpm --filter @arcompt/web dev -p ${webPort}`,
      url: `http://localhost:${webPort}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      cwd: "..",
    },
  ],
});
