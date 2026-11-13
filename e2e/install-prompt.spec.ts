// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * INVITE D'INSTALLATION DU PREMIER JOUR.
 *
 * Le propriétaire : « les utilisateurs ne sont pas techniciens » — ils ne
 * chercheront jamais le bouton d'installation du navigateur. L'application
 * doit la proposer elle-même, juste après l'activation du compte et la fin
 * de la configuration, une fois, sans harceler.
 *
 * Ce scénario exerce la mécanique de la carte (le vrai événement
 * `beforeinstallprompt` de Chrome dépend de critères d'engagement qu'un
 * test ne doit pas attendre : on le simule) :
 *
 *   1. dossier configuré + arrivée sur le tableau de bord → la carte paraît ;
 *   2. « Plus tard » la fait disparaître, et elle reste cachée après
 *      rechargement (report conservé sur l'appareil) ;
 *   3. « Installer ARCOMPT » déclenche l'invite capturée, une fois, et la
 *      confirmation paraît ;
 *   4. en mode autonome (déjà installé), la carte ne paraît jamais ;
 *   5. les réglages gardent une entrée manuelle permanente.
 */

// Les scripts d'initialisation ci-dessous s'exécutent DANS le navigateur ;
// le tsconfig e2e (types Node uniquement) ne déclare pas ses globaux.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;

const ctx = JSON.parse(readFileSync(join(__dirname, ".context.json"), "utf8")) as { tenantId: string; organizationId: string; userId: string };

const DIALOG = { role: "dialog" as const, name: "Installez ARCOMPT sur cet ordinateur" };

/** Simule l'invite native de Chrome : capturée par la coque, déclenchable une fois. */
async function stubInstallPrompt(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __installPromptCalls?: number };
    const fire = () => {
      const evt = new Event("beforeinstallprompt") as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: string; platform: string }>;
      };
      evt.prompt = async () => {
        w.__installPromptCalls = (w.__installPromptCalls ?? 0) + 1;
      };
      evt.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
      window.dispatchEvent(evt);
    };
    // Laisser la coque poser son écouteur, puis délivrer l'événement.
    // Sur une machine lente, l'hydratation peut prendre plusieurs secondes :
    // on redélivre l'événement jusqu'à ce qu'il ait pu être capturé (la coque
    // conserve la dernière occurrence ; seul le clic consomme l'invite).
    let deliveries = 0;
    const timer = window.setInterval(() => {
      fire();
      deliveries += 1;
      if (deliveries >= 20) window.clearInterval(timer);
    }, 1000);
  });
}

/** Simule un appareil où l'application tourne déjà installée (mode autonome). */
async function stubStandalone(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query.includes("display-mode")) {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        };
      }
      return original(query);
    };
  });
}

async function signedInPage(browser: Browser, prepare?: (context: BrowserContext) => Promise<void>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  if (prepare) await prepare(context);
  const page = await context.newPage();
  const res = await page.request.post("/api/session/dev", { data: ctx });
  expect(res.ok()).toBeTruthy();
  await page.goto("/dashboard?sw=1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return { context, page };
}

test.describe("invite d'installation du premier jour", () => {
  test.setTimeout(120_000);

  test("la carte paraît sur le tableau de bord ; « Plus tard » la tait durablement", async ({ browser }) => {
    const { context, page } = await signedInPage(browser, stubInstallPrompt);
    const dialog = page.getByRole(DIALOG.role, { name: DIALOG.name });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("button", { name: "Installer ARCOMPT" })).toBeVisible();
    await dialog.getByRole("button", { name: "Plus tard" }).click();
    await expect(dialog).toBeHidden();
    // Le report est conservé sur l'appareil : un rechargement ne ramène pas la carte.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(3_000);
    await expect(dialog).toBeHidden();
    await context.close();
  });

  test("« Installer ARCOMPT » déclenche l'invite capturée et confirme", async ({ browser }) => {
    const { context, page } = await signedInPage(browser, stubInstallPrompt);
    const dialog = page.getByRole(DIALOG.role, { name: DIALOG.name });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Installer ARCOMPT" }).click();
    await expect(page.getByText("ARCOMPT est installé : vous pouvez travailler hors ligne.")).toBeVisible({ timeout: 10_000 });
    const calls = await page.evaluate(() => (window as unknown as { __installPromptCalls?: number }).__installPromptCalls ?? 0);
    expect(calls).toBe(1);
    await context.close();
  });

  test("déjà installé (mode autonome) : la carte ne paraît jamais", async ({ browser }) => {
    const { context, page } = await signedInPage(browser, async (c) => {
      await stubStandalone(c);
      await stubInstallPrompt(c);
    });
    await page.waitForTimeout(3_500);
    await expect(page.getByRole(DIALOG.role, { name: DIALOG.name })).toBeHidden();
    await context.close();
  });

  test("les réglages gardent une entrée manuelle d'installation", async ({ browser }) => {
    const { context, page } = await signedInPage(browser, stubInstallPrompt);
    await page.goto("/settings");
    await expect(page.getByText("ARCOMPT sur cet appareil")).toBeVisible({ timeout: 15_000 });
    await context.close();
  });
});
