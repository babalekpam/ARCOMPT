import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
// `@arcompt/db` n'expose pas encore « ./testing » dans son export map : import relatif.
import { createTestDatabase } from "../../db/src/testing.js";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { AssetsService } from "./service.js";

/**
 * Intégration : dotations (écriture unique, équilibrée, idempotente), cession,
 * note annexe, isolation RLS. Ignoré sans DATABASE_URL.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let appDb: Db;
let userId: string;
let tenantA: string;
let tenantB: string;
let serviceA: AssetsService;
let serviceB: AssetsService;
let supplierA: string;

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  const orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 't@t.t', 'T') RETURNING id`;
  userId = u!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  const [p] = await withTenant(db, { tenantId: tenantA }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'SUPPLIER', 'Fournisseur immo', '481') RETURNING id`,
  );
  supplierA = p!.id as string;
  const sql = appDb as unknown as Sql;
  const ledgerFor = () => new Ledger(new PostgresStore(sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  serviceA = new AssetsService({ db: sql, ledger: ledgerFor(), ctx: { tenantId: tenantA, userId, organizationId: orgId }, currency: "XOF" });
  serviceB = new AssetsService({ db: sql, ledger: ledgerFor(), ctx: { tenantId: tenantB, userId, organizationId: orgId }, currency: "XOF" });
});

afterAll(async () => {
  await env?.drop();
});

async function entryLines(tenantId: string, entryId: string): Promise<Array<[string, string, string]>> {
  const rows = await withTenant(db, { tenantId }, (tx) =>
    tx`SELECT a.number, l.debit::text, l.credit::text FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ${entryId} ORDER BY l.line_no`,
  );
  return rows.map((r) => [r.number as string, r.debit as string, r.credit as string]);
}

run("Immobilisations — service", () => {
  let machineId: string;
  let vehicleId: string;

  it("crée une immobilisation avec son écriture d'acquisition (244 D / 481 C)", async () => {
    const asset = await serviceA.create({
      label: "Machine",
      accountNumber: "244",
      acquiredOn: "2025-04-01",
      cost: "1200000",
      durationMonths: 36,
      acquisition: { counterpartAccount: "481", partnerId: supplierA, reference: "FI-1" },
    });
    machineId = asset.id;
    expect(asset.depreciationAccountNumber).toBe("2844");
    expect(asset.acquisitionEntryId).not.toBeNull();
    expect(await entryLines(tenantA, asset.acquisitionEntryId!)).toEqual([
      ["244", "1200000.0000", "0.0000"],
      ["481", "0.0000", "1200000.0000"],
    ]);
    const { plan } = await serviceA.schedule(machineId);
    expect(plan.map((p) => p.dotation.toString())).toEqual(["301370.0000", "400000.0000", "400000.0000", "98630.0000"]);
  });

  it("refuse un compte hors classe 2 ou inconnu", async () => {
    await expect(serviceA.create({ label: "X", accountNumber: "601", acquiredOn: "2025-01-01", cost: "1", durationMonths: 12 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(serviceA.create({ label: "X", accountNumber: "24", acquiredOn: "2025-01-01", cost: "1", durationMonths: 12 })).rejects.toMatchObject({ code: "UNKNOWN_ACCOUNT" });
  });

  it("passe une dotation intermédiaire puis complète l'annuité à la clôture, de façon idempotente", async () => {
    const june = await serviceA.runDepreciation("2025", "2025-06-30");
    expect(june.entryId).not.toBeNull();
    expect(june.rows).toHaveLength(1);
    expect(june.rows[0]!.dotation.toString()).toBe("99726.0000"); // 301 370 × 91/275
    expect(await entryLines(tenantA, june.entryId!)).toEqual([
      ["681", "99726.0000", "0.0000"],
      ["2844", "0.0000", "99726.0000"],
    ]);

    const again = await serviceA.runDepreciation("2025", "2025-06-30");
    expect(again.entryId).toBeNull();
    expect(again.skipped[0]!.reason).toMatch(/déjà dotée/);

    const yearEnd = await serviceA.runDepreciation("2025");
    expect(yearEnd.rows[0]!.dotation.toString()).toBe("201644.0000"); // 301 370 − 99 726
    expect(yearEnd.rows[0]!.cumulative.toString()).toBe("301370.0000");
    expect(yearEnd.rows[0]!.netBookValue.toString()).toBe("898630.0000");

    const third = await serviceA.runDepreciation("2025");
    expect(third.entryId).toBeNull();
    expect(third.rows).toHaveLength(0);
  });

  it("cède une immobilisation : dotation complémentaire, sortie et produit de cession", async () => {
    const vehicle = await serviceA.create({ label: "Véhicule", accountNumber: "245", acquiredOn: "2025-01-01", cost: "3000000", durationMonths: 60 });
    vehicleId = vehicle.id;
    const result = await serviceA.dispose(vehicleId, "2025-09-30", "2500000", "521");
    // 600 000 × 273/365 = 448 767
    expect(result.cumulativeDepreciation.toString()).toBe("448767.0000");
    expect(result.netBookValue.toString()).toBe("2551233.0000");
    expect(result.gainLoss.toString()).toBe("-51233.0000");
    expect(await entryLines(tenantA, result.depreciationEntryId!)).toEqual([
      ["681", "448767.0000", "0.0000"],
      ["2845", "0.0000", "448767.0000"],
    ]);
    expect(await entryLines(tenantA, result.disposalEntryId)).toEqual([
      ["812", "2551233.0000", "0.0000"],
      ["2845", "448767.0000", "0.0000"],
      ["245", "0.0000", "3000000.0000"],
    ]);
    expect(await entryLines(tenantA, result.proceedsEntryId!)).toEqual([
      ["521", "2500000.0000", "0.0000"],
      ["822", "0.0000", "2500000.0000"],
    ]);
    expect(result.asset.disposedOn).toBe("2025-09-30");
    await expect(serviceA.dispose(vehicleId, "2025-10-01", "1", "521")).rejects.toMatchObject({ code: "ALREADY_DISPOSED" });
    // Une immobilisation cédée n'est plus dotée.
    const after = await serviceA.runDepreciation("2025");
    expect(after.entryId).toBeNull();
    expect((await serviceA.list()).map((a) => a.id)).toEqual([machineId]);
  });

  it("produit le tableau des immobilisations (notes 3A / 3C)", async () => {
    const notes = await serviceA.notes3A3C("2025");
    const materiel = notes.rows.find((r) => r.group === "24")!;
    expect(materiel.grossOpening.toString()).toBe("0.0000");
    expect(materiel.acquisitions.toString()).toBe("4200000.0000");
    expect(materiel.disposals.toString()).toBe("3000000.0000");
    expect(materiel.grossClosing.toString()).toBe("1200000.0000");
    expect(materiel.dotations.toString()).toBe("750137.0000"); // 301 370 + 448 767
    expect(materiel.reversals.toString()).toBe("448767.0000");
    expect(materiel.depreciationClosing.toString()).toBe("301370.0000");
    expect(materiel.netClosing.toString()).toBe("898630.0000");
    expect(notes.total.netClosing.toString()).toBe("898630.0000");
    // Cohérence avec le grand livre : solde 2844 + 2845 = amortissements de clôture.
    const rows = await withTenant(db, { tenantId: tenantA }, (tx) =>
      tx`SELECT a.number, sum(l.credit - l.debit)::text AS solde FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
          WHERE l.tenant_id = ${tenantA} AND e.status = 'VALIDATED' AND a.number LIKE '284%' GROUP BY a.number ORDER BY a.number`,
    );
    expect(rows.map((r) => [r.number, r.solde])).toEqual([
      ["2844", "301370.0000"],
      ["2845", "0.0000"],
    ]);
  });

  it("refuse la modification structurelle d'une fiche déjà dotée, accepte le libellé", async () => {
    await expect(serviceA.update(machineId, { durationMonths: 48 })).rejects.toMatchObject({ code: "ALREADY_DEPRECIATED" });
    const updated = await serviceA.update(machineId, { label: "Machine-outil" });
    expect(updated.label).toBe("Machine-outil");
    await expect(serviceA.remove(machineId)).rejects.toMatchObject({ code: "ALREADY_DEPRECIATED" });
  });

  it("isole les dossiers (RLS) : le dossier B ne voit rien du dossier A", async () => {
    expect(await serviceB.list({ includeDisposed: true })).toEqual([]);
    await expect(serviceB.get(machineId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(serviceB.dispose(machineId, "2025-12-31", "1", "521")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const notesB = await serviceB.notes3A3C("2025");
    expect(notesB.total.grossClosing.isZero()).toBe(true);
    // Lecture brute avec le rôle applicatif : aucune ligne du dossier A.
    const rows = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM asset_depreciation`);
    expect(rows[0]!.n).toBe(0);
  });
});
