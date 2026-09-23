import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { loadPack } from "@arcompt/country-packs";
import { TaxService } from "./service.js";
// `@arcompt/db` n'expose pas encore « ./testing » dans son export map : import relatif.
import { createTestDatabase } from "../../db/src/testing.js";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let userId: string;
let tenantA: string;
let tenantB: string;
let serviceA: TaxService;
let serviceB: TaxService;
let ledgerA: Ledger;

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  const orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 't@t.t', 'T') RETURNING id`;
  userId = u!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  const sql = env.appDb as unknown as Sql;
  const pack = loadPack("ci");
  // Le pack `ci` est en DRAFT : ces tests décrivent le parcours déclaratif
  // complet, ils passent donc par l'échappement de pré-production. Le refus
  // lui-même est éprouvé par pack-status.integration.test.ts.
  const preprod = { ALLOW_INSECURE_DRAFT_PACK_FILINGS: "1" };
  ledgerA = new Ledger(new PostgresStore(sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  serviceA = new TaxService({ db: sql, ledger: ledgerA, ctx: { tenantId: tenantA, userId, organizationId: orgId }, currency: "XOF", pack, env: preprod });
  serviceB = new TaxService({ db: sql, ledger: ledgerA, ctx: { tenantId: tenantB, userId, organizationId: orgId }, currency: "XOF", pack, env: preprod });

  const [client] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Client', '411') RETURNING id`);
  const [supplier] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'SUPPLIER', 'Fournisseur', '401') RETURNING id`);
  const actor = { userId, tenantId: tenantA };
  await ledgerA.post(actor, {
    journalCode: "AN",
    date: "2025-01-01",
    label: "À-nouveaux",
    source: "IMPORT",
    lines: [
      { accountNumber: "521", debit: "5000000" },
      { accountNumber: "101", credit: "5000000" },
    ],
  });
  await ledgerA.post(actor, {
    journalCode: "VT",
    date: "2025-03-15",
    label: "Facture",
    source: "INVOICE",
    lines: [
      { accountNumber: "411", debit: "1180000", partnerId: client!.id as string },
      { accountNumber: "706", credit: "1000000" },
      { accountNumber: "443", credit: "180000", vatCode: "TVA18" },
    ],
  });
  await ledgerA.post(actor, {
    journalCode: "AC",
    date: "2025-03-20",
    label: "Loyer",
    source: "PURCHASE",
    lines: [
      { accountNumber: "622", debit: "400000" },
      { accountNumber: "445", debit: "72000", vatCode: "TVA18" },
      { accountNumber: "401", credit: "472000", partnerId: supplier!.id as string },
    ],
  });
  await ledgerA.post(actor, {
    journalCode: "AC",
    date: "2025-03-25",
    label: "Prestataire avec retenue",
    source: "PURCHASE",
    lines: [
      { accountNumber: "632", debit: "100000" },
      { accountNumber: "447", credit: "5000", label: "Retenue BNC" },
      { accountNumber: "401", credit: "95000", partnerId: supplier!.id as string },
    ],
  });
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

run("Fiscalité — service", () => {
  let vatId: string;

  it("calcule la TVA de mars depuis le grand livre puis la valide (liquidation 443 D / 445 C / 444 C)", async () => {
    const { taxReturn, computation } = await serviceA.computeVat({ from: "2025-03-01", to: "2025-03-31" });
    vatId = taxReturn.id;
    expect(taxReturn.status).toBe("COMPUTED");
    expect(computation.totalCollected.toString()).toBe("180000.0000");
    expect(computation.totalDeductible.toString()).toBe("72000.0000");
    expect(taxReturn.amountDue.toString()).toBe("108000.0000");
    expect(computation.collected[0]!.base!.toString()).toBe("1000000.0000");

    await expect(serviceA.payVat(vatId, { date: "2025-04-15" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const validated = await serviceA.validateVat(vatId);
    expect(validated.status).toBe("VALIDATED");
    expect(await entryLines(tenantA, validated.entryId!)).toEqual([
      ["443", "180000.0000", "0.0000"],
      ["445", "0.0000", "72000.0000"],
      ["444", "0.0000", "108000.0000"],
    ]);
    await expect(serviceA.computeVat({ from: "2025-03-01", to: "2025-03-31" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(serviceA.validateVat(vatId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("règle la TVA (444 D / 521 C) une seule fois, puis marque le dépôt", async () => {
    const paid = await serviceA.payVat(vatId, { date: "2025-04-15" });
    expect(await entryLines(tenantA, paid.paymentEntryId!)).toEqual([
      ["444", "108000.0000", "0.0000"],
      ["521", "0.0000", "108000.0000"],
    ]);
    await expect(serviceA.payVat(vatId, { date: "2025-04-16" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const filed = await serviceA.markFiled(vatId, "EIMPOTS-2025-03-0001");
    expect(filed.status).toBe("FILED");
    expect(filed.filedAt).not.toBeNull();
  });

  it("ignore l'écriture de liquidation dans le calcul suivant et reporte le crédit", async () => {
    // Avril : aucune opération → net nul ; on force un crédit antérieur pour vérifier le report.
    const { computation } = await serviceA.computeVat({ from: "2025-04-01", to: "2025-04-30", previousCredit: "1500" });
    expect(computation.totalCollected.isZero()).toBe(true);
    expect(computation.creditCarried.toString()).toBe("1500.0000");
    const list = await serviceA.listReturns("VAT");
    expect(list).toHaveLength(2);
  });

  it("calcule les acomptes IS et le registre des retenues", async () => {
    const { taxReturn, computation } = await serviceA.isInstalments({ fiscalYearCode: "2025", fiscalResult: "1000000", turnover: "1000000" });
    expect(taxReturn.kind).toBe("IS_INSTALMENT");
    expect(computation.due.toString()).toBe("250000.0000");
    expect(computation.instalments).toHaveLength(4);
    const register = await serviceA.withholdingRegister("2025-01-01", "2025-12-31");
    expect(register.rows).toHaveLength(1);
    expect(register.rows[0]!.partnerName).toBeNull();
    expect(register.totalWithheld.toString()).toBe("5000.0000");
    expect(register.balance.toString()).toBe("5000.0000");
  });

  it("assemble la DSF et exporte un classeur Excel avec les onglets attendus", async () => {
    const { dsf, taxReturn } = await serviceA.buildDsf("2025", { reintegrations: "10000", deductions: "0" });
    expect(taxReturn.kind).toBe("DSF");
    expect(dsf.statements.publishable).toBe(true);
    // Résultat comptable : 1 000 000 − 400 000 − 100 000 = 500 000 ; fiscal : + 10 000.
    expect(dsf.fiscal.accountingResult.toString()).toBe("500000.0000");
    expect(dsf.fiscal.fiscalResult.toString()).toBe("510000.0000");
    const { buffer } = await serviceA.dsfWorkbook("2025", { reintegrations: "10000", deductions: "0" });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Bilan actif", "Bilan passif", "Compte de résultat", "TFT", "Notes", "Passage fiscal"]);
  });

  it("produit le calendrier avec les dépôts effectués", async () => {
    const cal = await serviceA.calendar(2025, "2025-05-01");
    expect(cal.find((d) => d.calendarId === "vat" && d.periodLabel === "2025-03")!.status).toBe("DONE");
    expect(cal.find((d) => d.calendarId === "vat" && d.periodLabel === "2025-02")!.status).toBe("OVERDUE");
  });

  it("isole les dossiers (RLS)", async () => {
    expect(await serviceB.listReturns()).toEqual([]);
    await expect(serviceB.getReturn(vatId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(serviceB.validateVat(vatId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { computation } = await serviceB.computeVat({ from: "2025-03-01", to: "2025-03-31" });
    expect(computation.totalCollected.isZero()).toBe(true);
  });
});
