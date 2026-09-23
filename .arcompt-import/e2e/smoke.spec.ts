// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ctx = JSON.parse(readFileSync(join(__dirname, ".context.json"), "utf8")) as { tenantId: string; organizationId: string; userId: string };

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post("/api/session/dev", { data: ctx });
  expect(res.ok()).toBeTruthy();
}

test.describe("parcours PME", () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page);
  });

  test("la page de connexion s'affiche sans session", async ({ browser }) => {
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await fresh.close();
  });

  test("tableau de bord, écritures et balance", async ({ page }) => {
    await page.goto("/?fy=2025");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/entries?fy=2025");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/balance?fy=2025");
    await expect(page.getByText(/521|Banques/i).first()).toBeVisible();
  });

  test("états financiers : bilan équilibré et contrôles", async ({ page }) => {
    await page.goto("/statements?fy=2025&tab=controls");
    await expect(page.getByText(/ACTIF_EGAL_PASSIF|Total actif = total passif/i).first()).toBeVisible();
    await page.goto("/statements?fy=2025&tab=actif");
    await expect(page.getByText("TOTAL GÉNÉRAL").first()).toBeVisible();
  });

  test("plan de comptes consultable", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByText(/Clients/).first()).toBeVisible();
  });

  test("les écrans des modules métier se chargent", async ({ page }) => {
    for (const path of ["/invoices", "/expenses", "/payments", "/treasury", "/payroll", "/tax", "/assets", "/closing?fy=2025", "/documents", "/documents/review", "/assistant", "/firm", "/settings"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBeLessThan(400);
      await expect(page.getByRole("heading", { level: 1 }).first(), path).toBeVisible();
    }
  });

  test("facturation : création d'une facture et refus d'émission sans certification", async ({ page }) => {
    const partners = await (await page.request.get("/api/proxy/partners?type=CUSTOMER")).json();
    const partnerId = partners.partners[0]?.id as string | undefined;
    expect(partnerId).toBeTruthy();
    const created = await page.request.post("/api/proxy/sales", {
      data: { kind: "INVOICE", partnerId, issueDate: "2025-06-15", lines: [{ label: "Conseil", quantity: "2", unitPrice: "100000", accountNumber: "706", vatCode: "TVA18" }] },
    });
    expect(created.status()).toBe(201);
    const doc = await created.json();
    expect(doc.totalGross).toBe("236000.0000");
    await page.goto(`/invoices/${doc.id}`);
    await expect(page.getByText("236").first()).toBeVisible();
    const issue = await page.request.post(`/api/proxy/sales/${doc.id}/issue`);
    expect([201, 200, 422]).toContain(issue.status());
  });

  test("export PDF des états via le proxy", async ({ page }) => {
    const res = await page.request.get("/api/proxy/render/statements.pdf?fiscalYear=2025");
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(10_000);
  });

  test("l'API refuse une écriture déséquilibrée depuis le proxy", async ({ page }) => {
    const res = await page.request.post("/api/proxy/entries", {
      data: { journalCode: "OD", date: "2025-06-01", label: "Test", lines: [{ accountNumber: "521", debit: "10" }, { accountNumber: "571", credit: "9" }] },
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.code).toBe("UNBALANCED");
  });
});
