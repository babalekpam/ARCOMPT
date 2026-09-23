// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Ledger, PostgresStore, type Actor } from "@arcompt/ledger";
import { withTenant, type Db } from "./client.js";
import { seedCompany } from "./seed.js";
import { createTestDatabase } from "./testing.js";

/**
 * Tests d'intégration : invariants garantis par la base et isolation entre
 * dossiers. Ils exigent DATABASE_URL (superuser local pour créer une base
 * jetable) ; sans variable, la suite est ignorée.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let appDb: Db;
let orgId: string;
let userId: string;
let tenantA: string;
let tenantB: string;
let ledgerA: Ledger;
let ledgerB: Ledger;
let actorA: Actor;
let actorB: Actor;
let clientA: string;

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 't@t.t', 'T') RETURNING id`;
  userId = u!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "SN", currency: "XOF", packVersion: "sn@2025.1", fiscalYear: fy })).companyId;
  const [p] = await withTenant(db, { tenantId: tenantA }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Client', '411') RETURNING id`,
  );
  clientA = p!.id as string;
  // Le moteur tourne avec le rôle applicatif, soumis à la RLS.
  ledgerA = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  ledgerB = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  actorA = { userId, tenantId: tenantA };
  actorB = { userId, tenantId: tenantB };
});

afterAll(async () => {
  await env?.drop();
});

const sale = (partnerId: string, ref = "FAC-1") => ({
  journalCode: "VT",
  date: "2025-03-15",
  reference: ref,
  label: "Facture",
  source: "INVOICE" as const,
  lines: [
    { accountNumber: "411", debit: "1180000", partnerId },
    { accountNumber: "706", credit: "1000000" },
    { accountNumber: "443", credit: "180000" },
  ],
});

run("PostgreSQL — invariants comptables", () => {
  it("valide, numérote et chaîne les écritures ; met à jour account_balance", async () => {
    const e1 = await ledgerA.post(actorA, sale(clientA, "FAC-1"));
    const e2 = await ledgerA.post(actorA, sale(clientA, "FAC-2"));
    expect(e1.number).toBe(1);
    expect(e2.number).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(await ledgerA.verifyChain(tenantA, "VT")).toEqual({ ok: true, checked: 2 });
    const rows = await withTenant(db, { tenantId: tenantA }, (tx) =>
      tx`SELECT a.number, b.debit::text, b.credit::text FROM account_balance b JOIN account a ON a.id = b.account_id WHERE b.tenant_id = ${tenantA} ORDER BY a.number`,
    );
    expect(rows.map((r) => [r.number, r.debit, r.credit])).toEqual([
      ["411", "2360000.0000", "0.0000"],
      ["443", "0.0000", "360000.0000"],
      ["706", "0.0000", "2000000.0000"],
    ]);
  });

  it("le trigger différé refuse une écriture déséquilibrée même en SQL direct", async () => {
    const journal = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id FROM journal WHERE tenant_id = ${tenantA} AND code = 'OD'`);
    const period = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id, fiscal_year_id FROM period WHERE tenant_id = ${tenantA} AND start_date = '2025-03-01'`);
    const accounts = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id, number FROM account WHERE tenant_id = ${tenantA} AND number IN ('521', '571')`);
    const acc = Object.fromEntries(accounts.map((a) => [a.number, a.id]));
    const id = randomUUID();
    await expect(
      withTenant(db, { tenantId: tenantA }, async (tx) => {
        await tx`INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
                 VALUES (${id}, ${tenantA}, ${journal[0]!.id}, ${period[0]!.fiscal_year_id}, ${period[0]!.id}, '2025-03-10', 'SQL direct', 'MANUAL', ${userId})`;
        await tx`INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, debit, credit, currency) VALUES (${randomUUID()}, ${tenantA}, ${id}, 1, ${acc["521"]}, 100, 0, 'XOF')`;
        await tx`INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, debit, credit, currency) VALUES (${randomUUID()}, ${tenantA}, ${id}, 2, ${acc["571"]}, 0, 90, 'XOF')`;
      }),
    ).rejects.toThrow(/déséquilibrée/);
  });

  it("interdit la modification et la suppression d'une écriture validée et de ses lignes", async () => {
    const e = await ledgerA.post(actorA, sale(clientA, "FAC-3"));
    const forbiddenUpdate = "UPDATE journal_entry SET label = 'x' WHERE id = $1";
    const forbiddenRemove = "DELETE FROM journal_entry WHERE id = $1";
    const forbiddenLineUpdate = "UPDATE journal_line SET debit = 1 WHERE entry_id = $1 AND line_no = 1";
    const forbiddenLineRemove = "DELETE FROM journal_line WHERE entry_id = $1";
    await expect(withTenant(db, { tenantId: tenantA }, (tx) => tx.unsafe(forbiddenUpdate, [e.id]))).rejects.toThrow(/modification interdite/);
    await expect(withTenant(db, { tenantId: tenantA }, (tx) => tx.unsafe(forbiddenRemove, [e.id]))).rejects.toThrow(/suppression interdite/);
    await expect(withTenant(db, { tenantId: tenantA }, (tx) => tx.unsafe(forbiddenLineUpdate, [e.id]))).rejects.toThrow(/validée/);
    await expect(withTenant(db, { tenantId: tenantA }, (tx) => tx.unsafe(forbiddenLineRemove, [e.id]))).rejects.toThrow(/validée/);
    // La contrepassation reste possible et le lien ne se pose qu'une fois.
    const r = await ledgerA.reverse(actorA, e.id);
    expect(r.reversesEntryId).toBe(e.id);
    await expect(ledgerA.reverse(actorA, e.id)).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
  });

  it("refuse toute insertion dans une période clôturée", async () => {
    const found = await withTenant(db, { tenantId: tenantA }, (tx) => tx`UPDATE period SET status = 'CLOSED' WHERE tenant_id = ${tenantA} AND start_date = '2025-02-01' RETURNING id`);
    expect(found).toHaveLength(1);
    await expect(ledgerA.post(actorA, { ...sale(clientA, "FAC-FEB"), date: "2025-02-10" })).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
  });

  it("refuse un numéro non continu ou une chaîne rompue en SQL direct", async () => {
    const e = await ledgerA.post(actorA, { ...sale(clientA, "FAC-4"), journalCode: "OD", lines: [{ accountNumber: "521", debit: "10" }, { accountNumber: "571", credit: "10" }] });
    expect(e.number).toBe(1);
    const draft = await ledgerA.createDraft(actorA, { ...sale(clientA, "FAC-5"), journalCode: "OD", lines: [{ accountNumber: "521", debit: "10" }, { accountNumber: "571", credit: "10" }] });
    await expect(
      withTenant(db, { tenantId: tenantA }, (tx) => tx`UPDATE journal_entry SET status = 'VALIDATED', number = 5, prev_hash = ${e.hash}, hash = repeat('a', 64) WHERE id = ${draft.id}`),
    ).rejects.toThrow(/numérotation non continue/);
    await expect(
      withTenant(db, { tenantId: tenantA }, (tx) => tx`UPDATE journal_entry SET status = 'VALIDATED', number = 2, prev_hash = repeat('b', 64), hash = repeat('a', 64) WHERE id = ${draft.id}`),
    ).rejects.toThrow(/chaîne de hash rompue/);
  });

  it("la piste d'audit est en insertion seule et chaînée", async () => {
    const rows = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id, prev_hash, hash FROM audit_log WHERE tenant_id = ${tenantA} ORDER BY id`);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]!.prev_hash).toBeNull();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    const forbiddenRemove = "DELETE FROM audit_log WHERE id = $1";
    await expect(withTenant(db, { tenantId: tenantA }, (tx) => tx.unsafe(forbiddenRemove, [rows[0]!.id]))).rejects.toThrow(/interdit/);
  });
});

run("PostgreSQL — isolation entre dossiers (RLS)", () => {
  it("le dossier B ne voit ni les écritures ni les comptes ni l'audit du dossier A", async () => {
    await ledgerA.post(actorA, sale(clientA, "FAC-RLS"));
    const entriesSeenByB = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM journal_entry`);
    expect(entriesSeenByB[0]!.n).toBe(0);
    const linesSeenByB = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM journal_line`);
    expect(linesSeenByB[0]!.n).toBe(0);
    const accountsSeenByB = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM account WHERE tenant_id = ${tenantA}`);
    expect(accountsSeenByB[0]!.n).toBe(0);
    const auditSeenByB = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantA}`);
    expect(auditSeenByB[0]!.n).toBe(0);
    const tb = await ledgerB.trialBalance(tenantB, { fiscalYearCode: "2025" });
    expect(tb.rows).toHaveLength(0);
  });

  it("le dossier B ne peut pas écrire dans le dossier A, même en forgeant tenant_id", async () => {
    await expect(
      withTenant(appDb, { tenantId: tenantB }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Intrus', '411')`),
    ).rejects.toThrow(/row-level security/);
    await expect(ledgerB.validate(actorB, randomUUID())).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
  });

  it("sans contexte tenant, le rôle applicatif ne voit rien", async () => {
    const rows = await appDb`SELECT count(*)::int AS n FROM journal_entry`;
    expect(rows[0]!.n).toBe(0);
  });

  it("un dossier ne peut pas imputer sur un compte d'un autre dossier", async () => {
    const accB = await withTenant(db, { tenantId: tenantB }, (tx) => tx`SELECT id FROM account WHERE tenant_id = ${tenantB} AND number = '521'`);
    const journal = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id FROM journal WHERE tenant_id = ${tenantA} AND code = 'OD'`);
    const period = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id, fiscal_year_id FROM period WHERE tenant_id = ${tenantA} AND start_date = '2025-05-01'`);
    const id = randomUUID();
    await expect(
      withTenant(db, { tenantId: tenantA }, async (tx) => {
        await tx`INSERT INTO journal_entry (id, tenant_id, journal_id, fiscal_year_id, period_id, entry_date, label, source, created_by)
                 VALUES (${id}, ${tenantA}, ${journal[0]!.id}, ${period[0]!.fiscal_year_id}, ${period[0]!.id}, '2025-05-10', 'x', 'MANUAL', ${userId})`;
        await tx`INSERT INTO journal_line (id, tenant_id, entry_id, line_no, account_id, debit, credit, currency) VALUES (${randomUUID()}, ${tenantA}, ${id}, 1, ${accB[0]!.id}, 100, 0, 'XOF')`;
      }),
    ).rejects.toThrow(/autre dossier/);
  });
});
