// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createTestDatabase } from "../../../packages/db/src/testing.js";
import { createApp } from "./app.js";

/**
 * Tiers : l'identifiant fiscal est chiffré au repos et la recherche passe par
 * l'index aveugle. Ce que ce test fixe, c'est le contrat de recherche après
 * chiffrement : l'identifiant **entier** retrouve le tiers, un fragment ne le
 * retrouve plus, et la recherche par nom n'a pas changé.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

let db: Db;
let tenantId: string;
let otherTenantId: string;
let app: ReturnType<typeof createApp>;

const headers = (tenant: string, userId: string) => ({ "content-type": "application/json", "x-user-id": userId, "x-tenant-id": tenant, "x-roles": "OWNER" });

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  const appDb = env.appDb as unknown as Sql;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Tiers') RETURNING id`;
  const orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'tiers@t.t', 'T') RETURNING id`;
  const userId = u!.id as string;
  const fiscalYear = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantId = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  otherTenantId = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  app = createApp({
    quiet: true,
    auth: { mode: "dev" },
    db: appDb,
    ledgerFor: (ctx) => new Ledger(new PostgresStore(appDb, { userId: ctx.userId, organizationId: orgId }), { baseCurrency: "XOF" }),
  });
  headersFor = () => headers(tenantId, userId);
  headersOther = () => headers(otherTenantId, userId);
});

let headersFor: () => Record<string, string>;
let headersOther: () => Record<string, string>;

afterAll(async () => {
  await env?.drop();
});

run("Tiers — identifiant fiscal chiffré", () => {
  let partnerId: string;

  it("crée un tiers : l'identifiant revient en clair à l'API, mais la base n'en garde que du chiffré", async () => {
    const res = await app.request("/v1/partners", {
      method: "POST",
      headers: headersFor(),
      body: JSON.stringify({ type: "SUPPLIER", name: "Fournisseur Bêta", taxId: "CI-7654321-B" }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    partnerId = body.id;
    expect(body.taxId).toBe("CI-7654321-B");

    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT tax_id, tax_id_enc, tax_id_bidx FROM partner WHERE id = ${partnerId}`);
    expect(rows[0]!.tax_id).toBeNull();
    expect(String(rows[0]!.tax_id_enc)).toMatch(/^v2:1:/);
    expect(rows[0]!.tax_id_bidx).toBeTruthy();
    expect(JSON.stringify(rows)).not.toMatch(/7654321/);

    // Lecture unitaire : déchiffrée.
    expect((await json(await app.request(`/v1/partners/${partnerId}`, { headers: headersFor() }))).taxId).toBe("CI-7654321-B");
  });

  it("un tiers sans identifiant ne fait pas naître de clé de données", async () => {
    const res = await app.request("/v1/partners", { method: "POST", headers: headersOther(), body: JSON.stringify({ type: "CUSTOMER", name: "Client sans NCC" }) });
    expect(res.status).toBe(201);
    expect((await json(res)).taxId).toBeNull();
    const keys = await withTenant(db, { tenantId: otherTenantId }, (tx) => tx`SELECT count(*)::int AS n FROM payroll_tenant_key WHERE tenant_id = ${otherTenantId}`);
    expect(keys[0]).toEqual({ n: 0 });
  });

  const search = async (q: string) => (await json(await app.request(`/v1/partners?q=${encodeURIComponent(q)}`, { headers: headersFor() }))).partners as Array<{ id: string }>;

  it("la recherche retrouve le tiers par son identifiant entier, quelle que soit la ponctuation", async () => {
    expect((await search("CI-7654321-B")).map((p) => p.id)).toEqual([partnerId]);
    expect((await search("ci7654321b")).map((p) => p.id)).toEqual([partnerId]);
    expect((await search(" CI 7654321 B ")).map((p) => p.id)).toEqual([partnerId]);
  });

  it("la recherche par fragment d'identifiant ne retrouve plus rien : c'est le prix assumé du chiffrement", async () => {
    expect(await search("7654321")).toEqual([]);
    expect(await search("CI-765")).toEqual([]);
  });

  it("la recherche par nom n'a pas changé : elle reste par fragment", async () => {
    expect((await search("Bêta")).map((p) => p.id)).toEqual([partnerId]);
    expect((await search("fournisseur")).map((p) => p.id)).toEqual([partnerId]);
  });

  it("la mise à jour réécrit le chiffré et son index, et laisse le clair vide", async () => {
    const res = await app.request(`/v1/partners/${partnerId}`, { method: "PUT", headers: headersFor(), body: JSON.stringify({ taxId: "CI-9999999-Z" }) });
    expect(res.status).toBe(200);
    expect((await json(res)).taxId).toBe("CI-9999999-Z");
    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT tax_id, tax_id_enc FROM partner WHERE id = ${partnerId}`);
    expect(rows[0]!.tax_id).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/9999999/);
    expect((await search("CI-9999999-Z")).map((p) => p.id)).toEqual([partnerId]);
    expect(await search("CI-7654321-B")).toEqual([]);
  });
});
