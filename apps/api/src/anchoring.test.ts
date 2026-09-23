// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createTestDatabase } from "../../../packages/db/src/testing.js";
import { createApp } from "./app.js";

/**
 * Ancrage externe, de bout en bout (SECURITY.md engagement n° 10).
 *
 * Ce que ce test fixe : l'ancre du jour couvre **les deux** chaînes de hash
 * (écritures et piste d'audit), elle est conservée, publiée hors de la
 * plateforme, et elle sert à produire une preuve d'inclusion vérifiable. Et
 * surtout : quand les données bougent après coup, le dispositif le **dit** au
 * lieu de fabriquer une preuve cohérente avec l'état actuel — c'est la seule
 * raison d'être de tout l'ensemble.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

const DAY_ONE = "2025-03-03";
const DAY_TWO = "2025-03-04";

let db: Db;
let appDb: Sql;
let tenantId: string;
let otherTenantId: string;
let userId: string;
let orgId: string;
let app: ReturnType<typeof createApp>;
let appWithoutPublisher: ReturnType<typeof createApp>;
let entryIds: string[] = [];

const headers = (tenant: string) => ({ "content-type": "application/json", "x-user-id": userId, "x-tenant-id": tenant, "x-roles": "OWNER" });

/** Valide une écriture à une date donnée : l'horloge du moteur fixe `validated_at` et la ligne d'audit. */
async function postEntryOn(tenant: string, day: string, label: string, amount: string): Promise<string> {
  const ledger = new Ledger(new PostgresStore(appDb, { userId, organizationId: orgId }), {
    baseCurrency: "XOF",
    now: () => new Date(`${day}T10:00:00.000Z`),
  });
  const entry = await ledger.post(
    { tenantId: tenant, userId },
    {
      journalCode: "VT",
      date: day,
      label,
      source: "MANUAL",
      lines: [
        { accountNumber: "521", debit: amount },
        { accountNumber: "706", credit: amount },
      ],
    },
  );
  return entry.id;
}

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb as unknown as Sql;

  const [org] = await db`INSERT INTO organization (name) VALUES ('Ancrage') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'ancrage@t.t', 'A') RETURNING id`;
  userId = u!.id as string;
  const fiscalYear = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantId = (await seedCompany(db, { organizationId: orgId, name: "Ancré", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  otherTenantId = (await seedCompany(db, { organizationId: orgId, name: "Voisin", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;

  entryIds = [
    await postEntryOn(tenantId, DAY_ONE, "Vente 1", "1000"),
    await postEntryOn(tenantId, DAY_ONE, "Vente 2", "2000"),
    await postEntryOn(tenantId, DAY_TWO, "Vente 3", "3000"),
  ];
  await postEntryOn(otherTenantId, DAY_ONE, "Vente voisine", "500");

  const deps = {
    quiet: true,
    auth: { mode: "dev" as const },
    db: appDb,
    ledgerFor: (ctx: { userId: string }) => new Ledger(new PostgresStore(appDb, { userId: ctx.userId, organizationId: orgId }), { baseCurrency: "XOF" }),
  };
  // Publieur de test : l'ancre sort du service, pas du processus — assez pour
  // éprouver le chemin complet, et refusé en production par la configuration.
  process.env.ANCHOR_PUBLISHER = "memory";
  app = createApp(deps);
  delete process.env.ANCHOR_PUBLISHER;
  appWithoutPublisher = createApp(deps);
});

afterAll(async () => {
  delete process.env.ANCHOR_PUBLISHER;
  await env?.drop();
});

run("Ancrage externe", () => {
  it("sans publieur configuré, la fonction est coupée et annoncée, jamais simulée", async () => {
    const list = await json(await appWithoutPublisher.request("/v1/anchors", { headers: headers(tenantId) }));
    expect(list.enabled).toBe(false);
    expect(list.publisher).toBeNull();
    expect(list.degraded.join(" ")).toMatch(/Ancrage externe désactivé/);

    const res = await appWithoutPublisher.request("/v1/anchors/build", { method: "POST", headers: headers(tenantId), body: "{}" });
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("ANCHORING_DISABLED");
    expect(await db`SELECT count(*)::int AS n FROM ledger_anchor`.then((r) => r[0]!.n)).toBe(0);
  });

  it("ancre les jours révolus et publie chaque ancre hors de la plateforme", async () => {
    const res = await app.request("/v1/anchors/build", { method: "POST", headers: headers(tenantId), body: "{}" });
    expect(res.status).toBe(200);
    const report = await json(res);
    expect(report.built).toEqual([DAY_ONE, DAY_TWO]);
    expect(report.failed).toEqual([]);
    expect(report.published.map((p: { day: string }) => p.day)).toEqual([DAY_ONE, DAY_TWO]);
    expect(report.published[0].publisher).toBe("memory");

    const anchors = (await json(await app.request("/v1/anchors", { headers: headers(tenantId) }))).anchors;
    expect(anchors).toHaveLength(2);
    // Le premier jour porte deux écritures et leurs lignes d'audit (brouillon +
    // validation) : l'ancre couvre bien les deux chaînes de hash, pas la seule
    // chaîne des écritures.
    expect(anchors[0].counts.entries).toBe(2);
    expect(anchors[0].counts.audit).toBeGreaterThanOrEqual(2);
    expect(anchors[0].leafCount).toBe(anchors[0].counts.entries + anchors[0].counts.audit);
    expect(anchors[0].status).toBe("PUBLISHED");
    expect(anchors[0].prevAnchorHash).toBeNull();
    expect(anchors[1].prevAnchorHash).toBe(anchors[0].anchorHash);
    expect(anchors[0].receipt).toContain("ARCOMPT-ANCHOR-v1");
  });

  it("est idempotent : relancé, il ne réécrit rien", async () => {
    const before = await db`SELECT anchor_hash, published_at FROM ledger_anchor ORDER BY day`;
    const report = await json(await app.request("/v1/anchors/build", { method: "POST", headers: headers(tenantId), body: "{}" }));
    expect(report.built).toEqual([]);
    expect(report.published).toEqual([]);
    const after = await db`SELECT anchor_hash, published_at FROM ledger_anchor ORDER BY day`;
    expect(after).toEqual(before);
  });

  it("refuse d'ancrer une journée qui n'est pas finie", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await app.request("/v1/anchors/build", { method: "POST", headers: headers(tenantId), body: JSON.stringify({ day: today }) });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("DAY_NOT_ELAPSED");
  });

  it("produit une preuve d'inclusion vérifiable pour une écriture", async () => {
    const res = await app.request(`/v1/anchors/proof?entry=${entryIds[0]}`, { headers: headers(tenantId) });
    expect(res.status).toBe(200);
    const proof = await json(res);
    expect(proof.verified).toBe(true);
    expect(proof.rootMatchesToday).toBe(true);
    expect(proof.published).toBe(true);
    expect(proof.leaf.kind).toBe("ENTRY");
    expect(proof.anchor.day).toBe(DAY_ONE);
    expect(proof.proof.root).toBe(proof.anchor.merkleRoot);
    // La preuve porte la valeur de feuille préfixée, pas le hash nu : un hash
    // d'audit ne peut pas être présenté à sa place.
    expect(proof.proof.leaf).toBe(`ENTRY:${proof.leaf.hash}`);
  });

  it("sert une ancre à l'unité, preuve tierce comprise", async () => {
    const res = await app.request(`/v1/anchors/${DAY_ONE}`, { headers: headers(tenantId) });
    expect(res.status).toBe(200);
    const anchor = await json(res);
    expect(anchor.day).toBe(DAY_ONE);
    expect(anchor.rootMatchesToday).toBe(true);
    // C'est ce champ qu'un auditeur emporte : la trace rendue par le tiers.
    expect(anchor.publicationProof === null || typeof anchor.publicationProof === "string").toBe(true);
    expect(anchor.receipt).toContain(`anchor=${anchor.anchorHash}`);
    expect((await app.request("/v1/anchors/2020-01-01", { headers: headers(tenantId) })).status).toBe(404);
    expect((await app.request("/v1/anchors/pas-un-jour", { headers: headers(tenantId) })).status).toBe(400);
  });

  it("produit une preuve pour une ligne de piste d'audit", async () => {
    const [row] = await withTenant(db, { tenantId }, (tx) => tx`SELECT id::text AS id FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY id LIMIT 1`);
    const proof = await json(await app.request(`/v1/anchors/proof?audit=${row!.id}`, { headers: headers(tenantId) }));
    expect(proof.verified).toBe(true);
    expect(proof.leaf.kind).toBe("AUDIT");
  });

  it("refuse une écriture inconnue et une demande ambiguë", async () => {
    const unknown = await app.request("/v1/anchors/proof?entry=11111111-1111-4111-8111-111111111111", { headers: headers(tenantId) });
    expect(unknown.status).toBe(404);
    const both = await app.request(`/v1/anchors/proof?entry=${entryIds[0]}&audit=1`, { headers: headers(tenantId) });
    expect(both.status).toBe(400);
  });

  it("ne montre pas les ancres d'un autre dossier", async () => {
    const anchors = (await json(await app.request("/v1/anchors", { headers: headers(otherTenantId) }))).anchors;
    expect(anchors).toEqual([]);
    const proof = await app.request(`/v1/anchors/proof?entry=${entryIds[0]}`, { headers: headers(otherTenantId) });
    expect(proof.status).toBe(404);
  });

  it("interdit à l'application de réécrire ou d'effacer une ancre", async () => {
    await expect(
      withTenant(appDb as unknown as Db, { tenantId }, (tx) => tx`DELETE FROM ledger_anchor WHERE tenant_id = ${tenantId}`),
    ).rejects.toThrow(/interdite|permission denied/i);
    await expect(
      withTenant(appDb as unknown as Db, { tenantId }, (tx) => tx`UPDATE ledger_anchor SET merkle_root = repeat('0', 64) WHERE tenant_id = ${tenantId}`),
    ).rejects.toThrow(/immuable/i);
    await expect(
      withTenant(appDb as unknown as Db, { tenantId }, (tx) => tx`UPDATE ledger_anchor SET publication_ref = 'inventé' WHERE tenant_id = ${tenantId}`),
    ).rejects.toThrow(/republie/i);
  });

  it("vérifie la chaîne d'ancres et le recalcul des racines", async () => {
    const report = await json(await app.request("/v1/anchors/chain", { headers: headers(tenantId) }));
    expect(report).toMatchObject({ anchors: 2, chain: { ok: true }, tampered: [], unpublished: [], ok: true });
  });

  it("dénonce une écriture modifiée après son ancrage, au lieu de prouver l'état actuel", async () => {
    // Le seul adversaire capable d'en arriver là est celui qui peut désactiver
    // les triggers : propriétaire du schéma ou superutilisateur. C'est
    // précisément le trou que l'ancrage externe est censé combler.
    const victim = entryIds[0]!;
    const [before] = await db`SELECT hash FROM journal_entry WHERE id = ${victim}`;
    const originalHash = String(before!.hash);
    await db`ALTER TABLE journal_entry DISABLE TRIGGER USER`;
    await db`UPDATE journal_entry SET hash = repeat('9', 64) WHERE id = ${victim}`;
    await db`ALTER TABLE journal_entry ENABLE TRIGGER USER`;

    const chain = await json(await app.request("/v1/anchors/chain", { headers: headers(tenantId) }));
    // La chaîne d'ancres reste intacte — personne n'a touché à la table
    // d'ancres — mais la racine du jour ne se recalcule plus : c'est ce second
    // contrôle qui attrape la falsification.
    expect(chain.chain.ok).toBe(true);
    expect(chain.tampered).toEqual([DAY_ONE]);
    expect(chain.ok).toBe(false);

    const proof = await json(await app.request(`/v1/anchors/proof?entry=${entryIds[1]}`, { headers: headers(tenantId) }));
    expect(proof.rootMatchesToday).toBe(false);

    await db`ALTER TABLE journal_entry DISABLE TRIGGER USER`;
    await db`UPDATE journal_entry SET hash = ${originalHash} WHERE id = ${victim}`;
    await db`ALTER TABLE journal_entry ENABLE TRIGGER USER`;
    expect((await json(await app.request("/v1/anchors/chain", { headers: headers(tenantId) }))).ok).toBe(true);
  });
});
