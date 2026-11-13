// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * SCÉNARIO DU PROPRIÉTAIRE, de bout en bout :
 * « le premier jour ils créent leur compte, ils installent l'application sur
 * leur bureau, ils travaillent [hors ligne], quand internet revient ça se
 * synchronise automatiquement. »
 *
 * Déroulement : session en ligne (installation du SW, copie locale des
 * données de référence) → coupure réseau → saisie réelle (un tiers, un devis,
 * une écriture) → réouverture de l'app dans un NOUVEL onglet toujours hors
 * ligne → retour du réseau → synchronisation automatique, exactement une
 * fois (aucun doublon), prouvée côté serveur.
 *
 * Chaque vérification est collectée : le test rapporte TOUTES les ruptures du
 * scénario en une passe au lieu de s'arrêter à la première.
 */

const ctx = JSON.parse(readFileSync(join(__dirname, ".context.json"), "utf8")) as { tenantId: string; organizationId: string; userId: string };

const RUN = `HL${Date.now().toString(36).toUpperCase()}`;
const PARTNER_NAME = `Client ${RUN}`;
const LINE_LABEL = `Prestation ${RUN}`;
const ENTRY_LABEL = `Écriture ${RUN}`;
const DOC_NAME = `piece-${RUN}.png`;
// 1×1 PNG transparent.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    failures.push(`${name} — ${msg}`);
    console.log(`  ✗ ${name} — ${msg}`);
    return false;
  }
}

async function jsonList(page: Page, path: string): Promise<Record<string, unknown>[]> {
  const res = await page.request.get(path);
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  // Les enveloppes diffèrent selon la ressource — /sales rend un tableau
  // nu, /partners rend { partners: [...] }, /entries rend
  // { entries: [...] }. Ne pas déballer la bonne clé faisait lire
  // l'enveloppe elle-même comme un « élément » : le scénario a cru à un
  // tiers au départ et n'a jamais vu celui que la synchronisation avait
  // pourtant créé dès le retour du réseau (2026-10-29).
  for (const key of ["items", "partners", "entries", "sales", "documents", "data"] as const) {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [body as Record<string, unknown>];
}

/**
 * Écritures synchronisées portant ce libellé, comptées sur l'écran
 * « Écritures récentes » — la seule surface qui montre les brouillons :
 * GET /entries ne rend que les écritures VALIDÉES (c'est la vue du grand
 * livre, par conception), et l'API n'expose pas encore la liste des
 * brouillons. Après le rejeu, la liste récente est alimentée par la
 * RÉPONSE du serveur (identifiant serveur affiché en police mono) : une
 * ligne pareille prouve que le serveur a accepté l'écriture, et son
 * unicité — recoupée par l'étape d'idempotence API plus bas — prouve
 * qu'il ne l'a acceptée qu'une fois.
 */
async function syncedEntryCount(page: Page, label: string): Promise<number> {
  await page.goto("/entries");
  const rows = page.locator("li").filter({ hasText: label });
  await rows.first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
  let n = 0;
  for (let i = 0; i < (await rows.count()); i++) {
    // La ligne encore en file n'a pas d'identifiant serveur ; celle que le
    // serveur a acceptée affiche le préfixe du sien (span.font-mono).
    if (await rows.nth(i).locator("span.font-mono").count()) n++;
  }
  return n;
}

test("scénario propriétaire : installer, travailler hors ligne, synchronisation automatique sans doublon", async ({ browser }) => {
  test.setTimeout(240_000);
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();

  await test.step("connexion et installation (premier jour, en ligne)", async () => {
    const res = await page.request.post("/api/session/dev", { data: ctx });
    expect(res.ok()).toBeTruthy();
    await page.goto("/dashboard?sw=1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Le service worker prend le contrôle et précache la coquille.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: 30_000 });
    await page.waitForFunction(
      async () => {
        const names = await caches.keys();
        for (const name of names) {
          const keys = await (await caches.open(name)).keys();
          if (keys.some((r) => r.url.endsWith("/entries/new"))) return true;
        }
        return false;
      },
      undefined,
      { timeout: 30_000 },
    );
  });

  await test.step("visites en ligne : copies locales de référence", async () => {
    // Le formulaire de devis charge tiers + produits (copies locales),
    // le centre de synchronisation monte l'indicateur et ses files.
    await page.goto("/invoices/new?kind=QUOTE");
    await expect(page.getByRole("button", { name: "Enregistrer le brouillon" })).toBeVisible();
    await page.goto("/sync");
    await expect(page.getByText("Synchronisation", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(2_000); // laisser les copies locales s'écrire
  });

  const baseline = { partners: 0, entries: 0, sales: 0 };
  await test.step("état serveur de départ", async () => {
    baseline.partners = (await jsonList(page, "/api/proxy/partners")).length;
    baseline.entries = (await jsonList(page, "/api/proxy/entries?fiscalYear=2025&limit=500")).length;
    baseline.sales = (await jsonList(page, "/api/proxy/sales")).length;
    console.log(`  départ : ${baseline.partners} tiers, ${baseline.entries} écritures, ${baseline.sales} documents de vente`);
  });

  await context.setOffline(true);

  await test.step("hors ligne : créer un tiers et un devis", async () => {
    await page.goto("/invoices/new?kind=QUOTE");
    await expect(page.getByRole("button", { name: "Enregistrer le brouillon" })).toBeVisible();
    // Créer le tiers depuis le sélecteur (file d'opérations).
    await page.getByPlaceholder(/Rechercher un tiers/).click();
    await page.getByRole("button", { name: /Créer un tiers/ }).click();
    await page.getByLabel("Nom", { exact: true }).fill(PARTNER_NAME);
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText(PARTNER_NAME).first()).toBeVisible();
    // Ligne libre du devis.
    await page.getByLabel("Libellé", { exact: true }).fill(LINE_LABEL);
    await page.getByLabel("Qté").fill("2");
    await page.getByLabel("PU HT").fill("15000");
    await page.getByLabel("Compte", { exact: true }).fill("701");
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    // Le brouillon est accepté localement : l'app quitte le formulaire pour
    // le centre de synchronisation, là où l'utilisateur voit son envoi en
    // attente. La fiche du document ne peut pas être la destination : elle
    // est rendue côté serveur à partir de l'API et n'existe qu'après la
    // synchronisation — le flux EN LIGNE y aboutit (/invoices/<id>), le flux
    // hors ligne aboutit à /sync, par décision du produit
    // (SalesDocumentForm : « on emmène l'utilisateur là où il peut le voir »).
    await expect(page).toHaveURL(/\/sync$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /En attente d'envoi/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Tiers", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Vente (brouillon)").first()).toBeVisible();
  });

  await test.step("hors ligne : le centre de synchro montre l'attente", async () => {
    await page.goto("/sync");
    await expect(page.getByRole("heading", { name: /En attente d'envoi/ })).toBeVisible();
    await expect(page.getByText("Tiers", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Vente (brouillon)").first()).toBeVisible();
  });

  await check("hors ligne : ouvrir le formulaire d'écriture jamais visité en ligne", async () => {
    await page.goto("/entries/new");
    await expect(page.getByRole("heading", { name: "Nouvelle écriture" })).toBeVisible();
  });

  await check("hors ligne : le plan de comptes local alimente le sélecteur", async () => {
    const account = page.getByLabel("Compte", { exact: true }).first();
    await account.click();
    await account.fill("521");
    await expect(page.getByRole("option").filter({ hasText: "Banques" }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("option").filter({ hasText: "Banques" }).first().click();
  });

  await check("hors ligne : saisir une écriture brouillon équilibrée", async () => {
    await page.getByLabel("Libellé", { exact: true }).fill(ENTRY_LABEL);
    await page.locator('input[type="date"]').first().fill("2025-06-15");
    const accounts = page.getByLabel("Compte", { exact: true });
    const debits = page.getByPlaceholder("Débit");
    const credits = page.getByPlaceholder("Crédit");
    await accounts.nth(0).fill("601");
    await debits.nth(0).fill("10000");
    await accounts.nth(1).fill("521");
    await credits.nth(1).fill("10000");
    await page.getByRole("button", { name: "Enregistrer en brouillon" }).click();
    await expect(page.getByText(/clientId|Brouillon/i).first()).toBeVisible({ timeout: 15_000 });
  });

  await check("hors ligne : nouvel onglet, l'app s'ouvre et voit la file", async () => {
    const tab = await context.newPage();
    await tab.goto("/sync");
    await expect(tab.getByRole("heading", { name: /En attente d'envoi/ })).toBeVisible({ timeout: 20_000 });
    await expect(tab.getByText("Écriture (brouillon)").first()).toBeVisible();
    await tab.close();
  });

  await test.step("retour du réseau : synchronisation automatique", async () => {
    await context.setOffline(false);
    // L'événement « online » déclenche l'envoi sans aucune action.
    await expect
      .poll(
        async () => (await jsonList(page, "/api/proxy/partners")).filter((p) => p.name === PARTNER_NAME).length,
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(1);
  });

  await test.step("preuves serveur : exactement une fois chacun", async () => {
    await expect
      .poll(async () => (await jsonList(page, "/api/proxy/sales")).filter((d) => d.partnerName === PARTNER_NAME).length, { timeout: 60_000, intervals: [2_000] })
      .toBe(1);
    await expect
      .poll(async () => syncedEntryCount(page, ENTRY_LABEL), { timeout: 60_000, intervals: [2_000] })
      .toBe(1);
    const partners = await jsonList(page, "/api/proxy/partners");
    expect(partners.length).toBe(baseline.partners + 1);
  });

  await test.step("aucun doublon après une synchronisation forcée de plus", async () => {
    await page.goto("/sync");
    const syncBtn = page.getByRole("button", { name: "Synchroniser" }).first();
    if (await syncBtn.isVisible().catch(() => false)) await syncBtn.click();
    await page.waitForTimeout(3_000);
    expect((await jsonList(page, "/api/proxy/partners")).filter((p) => p.name === PARTNER_NAME).length).toBe(1);
    expect(await syncedEntryCount(page, ENTRY_LABEL)).toBe(1);
    expect((await jsonList(page, "/api/proxy/sales")).filter((d) => d.partnerName === PARTNER_NAME).length).toBe(1);
  });

  await test.step("idempotence au niveau API : même clientId rejoué", async () => {
    const clientId = randomUUID();
    const name = `Doublon ${RUN}`;
    const first = await page.request.post("/api/proxy/partners", { data: { name, type: "CUSTOMER", clientId } });
    expect(first.status()).toBe(201);
    const second = await page.request.post("/api/proxy/partners", { data: { name, type: "CUSTOMER", clientId } });
    // Contrat de l'API : un rejeu répond 200, pas 201 — rien n'a été créé
    // cette fois-ci — avec l'en-tête Idempotent-Replay (routes/partners.ts).
    expect(second.status()).toBe(200);
    expect(second.headers()["idempotent-replay"]).toBe("true");
    expect((await jsonList(page, "/api/proxy/partners")).filter((p) => p.name === name).length).toBe(1);
  });

  await check("hors ligne : déposer une pièce, elle part au retour du réseau", async () => {
    await page.goto("/documents");
    // « Déposer une pièce » est un lien (bouton-lien de l'en-tête), pas un
    // bouton : le chercher par rôle « button » ne menait nulle part et le
    // scénario mourait sur son délai global sans un mot (2026-10-29).
    await page.getByRole("link", { name: "Déposer une pièce" }).click();
    await expect(page).toHaveURL(/\/documents\/upload$/);
    await context.setOffline(true);
    await page.locator('input[type="file"]').first().setInputFiles({ name: DOC_NAME, mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Envoyer" }).click();
    // Texte du produit quand la pièce est mise en file sur l'appareil.
    await expect(page.getByText(/conservée sur cet appareil|en attente/i).first()).toBeVisible({ timeout: 15_000 });
    await context.setOffline(false);
    // L'API n'expose pas GET /documents : la liste des pièces est dérivée
    // des propositions, tous statuts confondus (components/documents/
    // queries.ts — une pièce par identifiant). On compte donc, comme
    // l'écran le fait, les groupes de revue qui portent le nom du fichier.
    await expect
      .poll(
        async () => {
          let count = 0;
          for (const status of ["PENDING", "VALIDATED", "CORRECTED", "REJECTED"]) {
            const res = await page.request.get(`/api/proxy/proposals?status=${status}&route=ALL&limit=200`);
            if (!res.ok()) continue;
            const groups = (await res.json()) as unknown[];
            if (Array.isArray(groups)) count += groups.filter((g) => JSON.stringify(g).includes(DOC_NAME)).length;
          }
          return count;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(1);
  });

  await context.close();
  expect(failures, `ruptures du scénario :\n- ${failures.join("\n- ")}`).toEqual([]);
});
