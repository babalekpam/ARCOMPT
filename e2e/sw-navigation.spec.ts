// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * NAVIGATION FRAÎCHE HORS LIGNE — le défaut constaté en conditions réelles
 * le 2026-10-29 : /sync atteint par la navigation interne (lien de la coque,
 * jamais par un chargement de document), puis rechargé sans réseau, tombait
 * sur la page statique /offline.html alors que l'application était sur
 * l'appareil. Le lancement de l'application installée est la même
 * navigation fraîche.
 *
 * Attendu : une navigation fraîche hors ligne sert l'application (document
 * exact s'il est conservé, sinon la coquille), le routeur client affiche
 * l'écran demandé, et le travail hors ligne reste possible. /offline.html
 * n'est due que si aucun document de l'application n'est conservé.
 */

const ctx = JSON.parse(readFileSync(join(__dirname, ".context.json"), "utf8")) as { tenantId: string; organizationId: string; userId: string };

const OFFLINE_PAGE_TEXT = "Cette page n'est pas disponible sans réseau";

test("navigation fraîche hors ligne : l'application s'ouvre, pas la page statique", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();

  await test.step("en ligne : connexion, coquille précachée, /sync atteint par navigation interne seulement", async () => {
    const res = await page.request.post("/api/session/dev", { data: ctx });
    expect(res.ok()).toBeTruthy();
    await page.goto("/dashboard?sw=1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForFunction(() => Boolean((navigator as { serviceWorker?: { controller: unknown } }).serviceWorker?.controller), undefined, { timeout: 30_000 });
    // /sync par le lien de la coque : aucun document /sync n'est chargé,
    // c'est exactement l'état de l'appareil du propriétaire.
    await page.getByRole("link", { name: /Synchronisation/ }).first().click();
    await expect(page.getByText("Synchronisation", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(2_000); // laisser le réchauffement et le cliché s'écrire
  });

  await context.setOffline(true);

  await test.step("hors ligne : navigation fraîche vers /sync → l'application, pas /offline.html", async () => {
    await page.goto("/sync");
    await expect(page.getByText(OFFLINE_PAGE_TEXT)).toHaveCount(0);
    // La coquille est là : la navigation de l'application répond présente.
    await expect(page.getByRole("link", { name: /Synchronisation/ }).first()).toBeVisible({ timeout: 20_000 });
  });

  await test.step("hors ligne : le centre de synchronisation s'ouvre depuis la coquille", async () => {
    await page.getByRole("link", { name: /Synchronisation/ }).first().click();
    await expect(page.getByText("Données de référence conservées")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(OFFLINE_PAGE_TEXT)).toHaveCount(0);
  });

  await test.step("hors ligne : navigation fraîche vers / (lancement de l'application installée)", async () => {
    await page.goto("/");
    await expect(page.getByText(OFFLINE_PAGE_TEXT)).toHaveCount(0);
    await expect(page.locator("body")).not.toBeEmpty();
  });

  await context.close();
});
