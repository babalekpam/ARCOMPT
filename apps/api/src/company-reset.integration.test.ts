// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createTestDatabase } from "../../../packages/db/src/testing.js";
import { createApp } from "./app.js";

/**
 * Zone sensible : la réinitialisation d’un dossier est réservée au rôle
 * OWNER, exige la saisie exacte du nom du dossier, supprime les données
 * métier en conservant la structure (plan de comptes, journaux,
 * exercices), journalise l’opération dans audit_log et ne touche jamais
 * au dossier voisin.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

let db: Db;
let appDb: Sql;
let tenantId: string;
let otherTenantId: string;
let userId: string;
let orgId: string;
let app: ReturnType<typeof createApp>;

const COMPANY_NAME = "Réinitialisation QA";
const headers = (tenant: string, roles = "OWNER") => ({
  "content-type": "application/json",
  "x-user-id": userId,
  "x-tenant-id": tenant,
  "x-roles": roles,
});

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb as unknown as Sql;

  const [org] = await db`INSERT INTO organization (name) VALUES ('Reset') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'reset@t.t', 'R') RETURNING id`;
  userId = u!.id as string;
  const fiscalYear = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantId = (await seedCompany(db, { organizationId: orgId, name: COMPANY_NAME, countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  otherTenantId = (await seedCompany(db, { organizationId: orgId, name: "Voisin Reset", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;

  // Données métier dans les deux dossiers : un tiers et une écriture chacun.
  for (const t of [tenantId, otherTenantId]) {
    await withTenant(db, { tenantId: t, organizationId: orgId }, async (tx) => {
      await tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${t}, 'CUSTOMER', 'Client Test', '411')`;
    });
    const ledger = new Ledger(new PostgresStore(appDb, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
    await ledger.post(
      { tenantId: t, userId },
      { journalCode: "VT", date: "2025-03-03", label: "Vente test", source: "MANUAL",
        lines: [{ accountNumber: "521", debit: "1000" }, { accountNumber: "706", credit: "1000" }] },
    );
  }

  app = createApp({
    quiet: true,
    auth: { mode: "dev" as const },
    db: appDb,
    ledgerFor: (ctx: { userId: string }) => new Ledger(new PostgresStore(appDb, { userId: ctx.userId, organizationId: orgId }), { baseCurrency: "XOF" }),
  });
});

afterAll(async () => {
  await env?.drop();
});

run("Zone sensible — réinitialisation du dossier", () => {
  it("refuse le résumé aux non-propriétaires", async () => {
    const res = await app.request("/v1/company/reset-summary", { headers: headers(tenantId, "ACCOUNTANT") });
    expect(res.status).toBe(403);
  });

  it("refuse la réinitialisation aux non-propriétaires", async () => {
    const res = await app.request("/v1/company/reset-data", {
      method: "POST",
      headers: headers(tenantId, "ACCOUNTANT"),
      body: JSON.stringify({ confirmName: COMPANY_NAME }),
    });
    expect(res.status).toBe(403);
  });

  it("expose les compteurs au propriétaire", async () => {
    const res = await app.request("/v1/company/reset-summary", { headers: headers(tenantId) });
    expect(res.status).toBe(200);
    const summary = await json(res);
    expect(summary.companyName).toBe(COMPANY_NAME);
    expect(summary.counts.partners).toBe(1);
    expect(summary.counts.journalEntries).toBe(1);
  });

  it("rejette une confirmation qui ne correspond pas au nom du dossier", async () => {
    const res = await app.request("/v1/company/reset-data", {
      method: "POST",
      headers: headers(tenantId),
      body: JSON.stringify({ confirmName: "Autre nom" }),
    });
    expect(res.status).toBe(400);
    const [row] = await db`SELECT count(*)::int AS n FROM partner WHERE tenant_id = ${tenantId}`;
    expect(row!.n).toBe(1);
  });

  it("supprime les données métier, conserve la structure et journalise", async () => {
    const res = await app.request("/v1/company/reset-data", {
      method: "POST",
      headers: headers(tenantId),
      body: JSON.stringify({ confirmName: COMPANY_NAME }),
    });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.ok).toBe(true);
    expect(out.removed.partner).toBe(1);
    expect(out.removed.journal_entry).toBe(1);
    expect(out.removed.journal_line).toBe(2);

    const [partners] = await db`SELECT count(*)::int AS n FROM partner WHERE tenant_id = ${tenantId}`;
    expect(partners!.n).toBe(0);
    const [entries] = await db`SELECT count(*)::int AS n FROM journal_entry WHERE tenant_id = ${tenantId}`;
    expect(entries!.n).toBe(0);
    // Structure conservée : plan de comptes, journaux, exercice.
    const [accounts] = await db`SELECT count(*)::int AS n FROM account WHERE tenant_id = ${tenantId}`;
    expect(accounts!.n).toBeGreaterThan(0);
    const [journals] = await db`SELECT count(*)::int AS n FROM journal WHERE tenant_id = ${tenantId}`;
    expect(journals!.n).toBeGreaterThan(0);
    const [years] = await db`SELECT count(*)::int AS n FROM fiscal_year WHERE tenant_id = ${tenantId}`;
    expect(years!.n).toBe(1);
    // Journalisation de l’opération.
    const audit = await db`SELECT action, entity FROM audit_log WHERE tenant_id = ${tenantId} AND action = 'company.reset_data'`;
    expect(audit).toHaveLength(1);
    // Le dossier voisin est intact.
    const [otherPartners] = await db`SELECT count(*)::int AS n FROM partner WHERE tenant_id = ${otherTenantId}`;
    expect(otherPartners!.n).toBe(1);
    const [otherEntries] = await db`SELECT count(*)::int AS n FROM journal_entry WHERE tenant_id = ${otherTenantId}`;
    expect(otherEntries!.n).toBe(1);
  });
});
