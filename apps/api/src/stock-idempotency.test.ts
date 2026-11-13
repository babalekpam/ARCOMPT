// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createTestDatabase } from "../../../packages/db/src/testing.js";
import { createApp } from "./app.js";

/**
 * La file hors ligne annonce les kinds stock.article / stock.movement /
 * stock.count : le serveur doit reconnaître leurs rejeux par `clientId`,
 * comme il le fait pour la facturation (idempotency.test.ts). Un mouvement
 * rejoué qui recréerait une ligne fausserait l'inventaire en silence.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

let db: Db;
let tenantId: string;
let app: ReturnType<typeof createApp>;
let headersFor: () => Record<string, string>;

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  const appDb = env.appDb as unknown as Sql;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Rejeu stock') RETURNING id`;
  const orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'stock@t.t', 'S') RETURNING id`;
  const userId = u!.id as string;
  const fiscalYear = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantId = (await seedCompany(db, { organizationId: orgId, name: "Stock", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  app = createApp({
    quiet: true,
    auth: { mode: "dev" },
    db: appDb,
    ledgerFor: (ctx) => new Ledger(new PostgresStore(appDb, { userId: ctx.userId, organizationId: orgId }), { baseCurrency: "XOF" }),
  });
  headersFor = () => ({ "content-type": "application/json", "x-user-id": userId, "x-tenant-id": tenantId, "x-roles": "OWNER" });
});

afterAll(async () => {
  await env?.drop();
});

run("Rejeu des créations de stock hors ligne", () => {
  const ARTICLE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const MOVEMENT_ID = "cccccccc-3333-4333-8333-cccccccccccc";
  const COUNT_ID = "dddddddd-4444-4444-8444-dddddddddddd";
  let articleId = "";

  it("article : le premier envoi crée, le second est reconnu sans doublon", async () => {
    const body = { code: "ART-REJEU", label: "Article rejoué", category: "MARCHANDISE", clientId: ARTICLE_ID };
    const first = await app.request("/v1/stock/articles", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    const created = await json(first);
    articleId = created.id;

    const second = await app.request("/v1/stock/articles", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(await json(second)).toEqual(created);

    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT count(*)::int AS n FROM stock_article WHERE code = 'ART-REJEU'`);
    expect(rows[0]!.n).toBe(1);
  });

  it("mouvement : un rejeu ne recompte pas la quantité", async () => {
    const body = { articleId, date: "2025-06-15", kind: "IN", reason: "OPENING", quantity: "10", unitCost: "100", clientId: MOVEMENT_ID };
    const first = await app.request("/v1/stock/movements", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/stock/movements", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");

    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT count(*)::int AS n FROM stock_movement WHERE article_id = ${articleId}`);
    expect(rows[0]!.n).toBe(1);
  });

  it("inventaire : un rejeu ne crée pas de second comptage", async () => {
    const body = { fiscalYearCode: "2025", date: "2025-06-15", lines: [{ articleId, countedQuantity: "10", unitCost: "100" }], clientId: COUNT_ID };
    const first = await app.request("/v1/stock/counts", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/stock/counts", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");

    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT count(*)::int AS n FROM stock_count`);
    expect(rows[0]!.n).toBe(1);
  });

  it("le même identifiant avec une autre saisie est refusé (409), jamais servi en silence", async () => {
    const res = await app.request("/v1/stock/articles", {
      method: "POST",
      headers: headersFor(),
      body: JSON.stringify({ code: "AUTRE", label: "Autre article", category: "MARCHANDISE", clientId: ARTICLE_ID }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
