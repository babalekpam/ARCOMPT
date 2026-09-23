import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { loadPack, type CountryPack } from "@arcompt/country-packs";
import { computeStatements } from "@arcompt/statements";
import { TaxService } from "./service.js";
// `@arcompt/db` n'expose pas encore « ./testing » dans son export map : import relatif.
import { createTestDatabase } from "../../db/src/testing.js";

/**
 * Le pack ne fait pas autorité : ce qui est refusé, ce qui ne l'est pas, et ce
 * que produit l'échappement de pré-production.
 *
 * La ligne est tracée sur ce qui sort de l'entreprise comme document légal.
 * D'un côté la tenue — écritures, balance, états financiers, TVA calculée à
 * l'écran — qui doit continuer de fonctionner sur un pack en cours de
 * rédaction. De l'autre les documents remis à l'administration : déclaration
 * validée, dépôt, acomptes d'IS, liasse DSF.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const draftPack = loadPack("ci");
const publishedPack: CountryPack = { ...draftPack, status: "PUBLISHED", reviewed_by: "Cabinet X, expert-comptable (CI)" };
const PREPROD = { ALLOW_INSECURE_DRAFT_PACK_FILINGS: "1" };

let db: Db;
let sql: Sql;
let userId: string;
let orgId: string;
let tenantId: string;
let ledger: Ledger;

/** Un service par situation de pack : brouillon, brouillon + échappement, publié. */
function service(pack: CountryPack, env?: Record<string, string | undefined>): TaxService {
  return new TaxService({
    db: sql,
    ledger,
    ctx: { tenantId, userId, organizationId: orgId },
    currency: "XOF",
    pack,
    company: { name: "SARL Brouillon", taxIds: { NCC: "1234567A" } },
    ...(env ? { env } : { env: {} }),
  });
}

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  sql = env.appDb as unknown as Sql;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Pack brouillon') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'draft@t.t', 'D') RETURNING id`;
  userId = u!.id as string;
  tenantId = (
    await seedCompany(db, {
      organizationId: orgId,
      name: "SARL Brouillon",
      countryCode: "CI",
      currency: "XOF",
      packVersion: "ci@2025.1",
      fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
    })
  ).companyId;
  ledger = new Ledger(new PostgresStore(sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });

  const [client] = await withTenant(db, { tenantId }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantId}, 'CUSTOMER', 'Client', '411') RETURNING id`);
  const actor = { userId, tenantId };
  await ledger.post(actor, {
    journalCode: "AN",
    date: "2025-01-01",
    label: "À-nouveaux",
    source: "IMPORT",
    lines: [
      { accountNumber: "521", debit: "3000000" },
      { accountNumber: "101", credit: "3000000" },
    ],
  });
  await ledger.post(actor, {
    journalCode: "VT",
    date: "2025-02-10",
    label: "Facture client",
    source: "INVOICE",
    lines: [
      { accountNumber: "411", debit: "1180000", partnerId: client!.id as string },
      { accountNumber: "706", credit: "1000000" },
      { accountNumber: "443", credit: "180000", vatCode: "TVA18" },
    ],
  });
});

afterAll(async () => {
  await env?.drop();
});

run("Pack non publié — ce qui est refusé", () => {
  it("refuse la validation d'une déclaration de TVA, en nommant le pack et le remède", async () => {
    const s = service(draftPack);
    const { taxReturn } = await s.computeVat({ from: "2025-02-01", to: "2025-02-28" });
    await expect(s.validateVat(taxReturn.id)).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
    await expect(s.validateVat(taxReturn.id)).rejects.toThrowError(/ci@2025\.1/);
    await expect(s.validateVat(taxReturn.id)).rejects.toThrowError(/DRAFT/);
    await expect(s.validateVat(taxReturn.id)).rejects.toThrowError(/reviewed_by/);
    await expect(s.validateVat(taxReturn.id)).rejects.toThrowError(/ALLOW_INSECURE_DRAFT_PACK_FILINGS/);
    // La déclaration reste au statut calculé : rien n'a été engagé.
    expect((await s.getReturn(taxReturn.id)).status).toBe("COMPUTED");
  });

  it("refuse le dépôt, les acomptes d'IS, la liasse DSF et son classeur", async () => {
    const s = service(draftPack);
    const { taxReturn } = await s.computeVat({ from: "2025-02-01", to: "2025-02-28" });
    await expect(s.markFiled(taxReturn.id, "EIMPOTS-XXX")).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
    await expect(s.isInstalments({ fiscalYearCode: "2025", fiscalResult: "1000000", turnover: "1000000" })).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
    await expect(s.buildDsf("2025", { reintegrations: "0", deductions: "0" })).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
    await expect(s.dsfWorkbook("2025", { reintegrations: "0", deductions: "0" })).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
    // Aucune liasse ni acompte n'a été enregistré.
    expect(await s.listReturns("DSF")).toEqual([]);
    expect(await s.listReturns("IS_INSTALMENT")).toEqual([]);
  });
});

run("Pack non publié — ce qui continue de marcher", () => {
  it("la tenue ordinaire n'est pas touchée : écritures, balance, états financiers", async () => {
    // Une PME qui essaie le produit doit pouvoir passer une écriture…
    const [supplier] = await withTenant(db, { tenantId }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantId}, 'SUPPLIER', 'Fournisseur', '401') RETURNING id`);
    const entry = await ledger.post(
      { userId, tenantId },
      {
        journalCode: "AC",
        date: "2025-02-20",
        label: "Achat fournitures",
        source: "PURCHASE",
        lines: [
          { accountNumber: "6055", debit: "100000" },
          { accountNumber: "445", debit: "18000", vatCode: "TVA18" },
          { accountNumber: "401", credit: "118000", partnerId: supplier!.id as string },
        ],
      },
    );
    expect(entry.status).toBe("VALIDATED");

    // …lire sa balance et ses états financiers, qui ne doivent rien au pack.
    const tb = await ledger.trialBalance(tenantId, { fiscalYearCode: "2025" });
    expect(tb.rows.length).toBeGreaterThan(0);
    const statements = await service(draftPack).statements("2025");
    expect(statements.statements.BILAN_ACTIF).toBeDefined();
    expect(computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: tb.rows }).controls.length).toBeGreaterThan(0);
  });

  it("la TVA se calcule à l'écran et le registre des retenues se lit, marqués non officiels", async () => {
    const s = service(draftPack);
    const { taxReturn, computation, official, packNotice } = await s.computeVat({ from: "2025-02-01", to: "2025-02-28" });
    expect(taxReturn.status).toBe("COMPUTED");
    expect(computation.totalCollected.toString()).toBe("180000.0000");
    // L'écran reçoit de quoi dire que le pack est un brouillon.
    expect(official).toBe(false);
    expect(packNotice).toContain("DRAFT");
    // Calculé depuis un pack en brouillon : marqué comme tel, au repos.
    expect(taxReturn.official).toBe(false);
    const [row] = await withTenant(db, { tenantId }, (tx) => tx`SELECT official FROM tax_return WHERE id = ${taxReturn.id}`);
    expect(row!.official).toBe(false);

    expect((await s.withholdingRegister("2025-01-01", "2025-12-31")).rows).toEqual([]);
    expect((await s.calendar(2025, "2025-03-01")).length).toBeGreaterThan(0);
  });
});

run("Pack non publié — échappement de pré-production", () => {
  it("produit la liasse, mais visiblement non officielle", async () => {
    const s = service(draftPack, PREPROD);
    const { dsf, taxReturn } = await s.buildDsf("2025", { reintegrations: "0", deductions: "0" });
    expect(dsf.official).toBe(false);
    expect(dsf.notice).toContain("DOCUMENT NON OFFICIEL");
    expect(taxReturn.official).toBe(false);
    expect(taxReturn.data.official).toBe(false);

    const { buffer, dsf: again } = await s.dsfWorkbook("2025", { reintegrations: "0", deductions: "0" });
    expect(again.official).toBe(false);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    // La mention est la première ligne de CHAQUE onglet : le classeur est déposé tel quel.
    for (const ws of wb.worksheets) {
      expect(String(ws.getRow(1).getCell(1).value ?? "")).toContain("DOCUMENT NON OFFICIEL");
    }
  });

  it("valide et dépose une déclaration, en la marquant non officielle au repos", async () => {
    const s = service(draftPack, PREPROD);
    const { taxReturn } = await s.computeVat({ from: "2025-01-01", to: "2025-01-31" });
    const validated = await s.validateVat(taxReturn.id);
    expect(validated.status).toBe("VALIDATED");
    expect(validated.official).toBe(false);
    const filed = await s.markFiled(taxReturn.id, "EIMPOTS-PREPROD-1");
    expect(filed.status).toBe("FILED");
    expect(filed.official).toBe(false);
  });
});

run("Pack publié", () => {
  it("un pack PUBLISHED et revu produit des documents officiels, sans mention", async () => {
    const s = service(publishedPack);
    const { dsf, taxReturn } = await s.buildDsf("2025", { reintegrations: "0", deductions: "0" });
    expect(dsf.official).toBe(true);
    expect(dsf.notice).toBeNull();
    expect(taxReturn.official).toBe(true);
    const { buffer } = await s.dsfWorkbook("2025", { reintegrations: "0", deductions: "0" });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    for (const ws of wb.worksheets) {
      expect(String(ws.getRow(1).getCell(1).value ?? "")).not.toContain("DOCUMENT NON OFFICIEL");
    }
    const { taxReturn: is } = await s.isInstalments({ fiscalYearCode: "2025", fiscalResult: "1000000", turnover: "1000000" });
    expect(is.official).toBe(true);
  });
});
