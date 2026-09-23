// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createTestDatabase } from "../../../packages/db/src/testing.js";
import { createApp } from "./app.js";
import { canonicalJson, requestHash } from "./idempotency.js";

/**
 * Ce que ces tests fixent : un rejeu ne crée pas de doublon, un identifiant
 * réutilisé pour une AUTRE saisie est refusé plutôt que servi de la réponse
 * précédente, et l'isolation par dossier vaut aussi pour le registre de rejeu.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

let db: Db;
let tenantId: string;
let otherTenantId: string;
let app: ReturnType<typeof createApp>;
let headersFor: () => Record<string, string>;
let headersOther: () => Record<string, string>;

const headers = (tenant: string, userId: string) => ({ "content-type": "application/json", "x-user-id": userId, "x-tenant-id": tenant, "x-roles": "OWNER" });

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  const appDb = env.appDb as unknown as Sql;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Rejeu') RETURNING id`;
  const orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'rejeu@t.t', 'R') RETURNING id`;
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

afterAll(async () => {
  await env?.drop();
});

describe("Empreinte canonique", () => {
  it("l'ordre des clés ne change rien, l'ordre des lignes en change", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    // Les lignes d'un document sont ordonnées : deux ordres sont deux saisies.
    expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }));
  });

  it("une clé absente et une clé à undefined sont la même chose", () => {
    expect(requestHash("x.y", { a: 1 })).toBe(requestHash("x.y", { a: 1, b: undefined }));
  });

  it("l'opération fait partie de l'empreinte", () => {
    expect(requestHash("partner.create", { a: 1 })).not.toBe(requestHash("product.create", { a: 1 }));
  });
});

run("Rejeu des créations hors ligne", () => {
  const CLIENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const body = { type: "CUSTOMER", name: "Client rejoué", clientId: CLIENT_ID };

  it("le premier envoi crée, le second rend la même réponse sans rien créer", async () => {
    const first = await app.request("/v1/partners", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    const created = await json(first);

    const second = await app.request("/v1/partners", { method: "POST", headers: headersFor(), body: JSON.stringify(body) });
    // 200 et non 201 : rien n'a été créé cette fois-ci, et l'en-tête le dit.
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(await json(second)).toEqual(created);

    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT count(*)::int AS n FROM partner WHERE name = 'Client rejoué'`);
    expect(rows[0]!.n).toBe(1);
  });

  it("le même identifiant avec une autre saisie est refusé, pas servi de l'ancienne", async () => {
    const res = await app.request("/v1/partners", {
      method: "POST",
      headers: headersFor(),
      body: JSON.stringify({ ...body, name: "Un tout autre client" }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("IDEMPOTENCY_CONFLICT");

    // La saisie divergente ne doit surtout pas avoir été enregistrée en douce.
    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT count(*)::int AS n FROM partner WHERE name = 'Un tout autre client'`);
    expect(rows[0]!.n).toBe(0);
  });

  it("le registre est cloisonné par dossier : le même identifiant vaut ailleurs", async () => {
    const res = await app.request("/v1/partners", { method: "POST", headers: headersOther(), body: JSON.stringify(body) });
    expect(res.status).toBe(201);
  });

  it("sans identifiant de rejeu, rien ne change : deux envois créent deux tiers", async () => {
    const send = () => app.request("/v1/partners", { method: "POST", headers: headersFor(), body: JSON.stringify({ type: "CUSTOMER", name: "Sans rejeu" }) });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT count(*)::int AS n FROM partner WHERE name = 'Sans rejeu'`);
    expect(rows[0]!.n).toBe(2);
  });

  it("une trace complétée est immuable : la base refuse de la réécrire", async () => {
    await expect(
      withTenant(db, { tenantId }, (tx) => tx`UPDATE idempotency_record SET response = '{}'::jsonb WHERE tenant_id = ${tenantId} AND client_id = ${CLIENT_ID}`),
    ).rejects.toThrow(/immuable/);
  });

  it("une trace récente ne s'efface pas : un appareil hors ligne doit encore pouvoir rejouer", async () => {
    const purge = (tx: Sql) => tx`DELETE FROM idempotency_record WHERE tenant_id = ${tenantId} AND client_id = ${CLIENT_ID}`;
    await expect(withTenant(db, { tenantId }, purge)).rejects.toThrow(/7 jours/);
  });
});
