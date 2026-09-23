import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { loadPack } from "@arcompt/country-packs";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createTestDatabase } from "../../db/src/testing.js";
import { EnvKeyProvider, PayrollCrypto } from "./crypto.js";
import { PayrollService } from "./service.js";

/**
 * Paie sur un pack pays non publié : ce qui est refusé (les déclarations
 * sociales, ce qui part à l'organisme), ce qui continue (le cycle de paie et
 * son écriture, qui sont de la tenue) et ce qui est marqué (le bulletin).
 *
 * Éprouve aussi que l'identifiant fiscal d'un salarié et de son tiers est
 * chiffré au repos, comme le salaire.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const masterKey = randomBytes(32);
const pack = loadPack("ci");
const published = { ...pack, status: "PUBLISHED" as const, reviewed_by: "Cabinet X, expert-comptable (CI)" };

let db: Db;
let appDb: Db;
let orgId: string;
let userId: string;
let tenantId: string;
let strict: PayrollService;
let preprod: PayrollService;
let employeeId: string;
let partnerId: string;
let runId: string;

const makeService = (opts: { env?: Record<string, string | undefined>; pack?: typeof pack } = {}) =>
  new PayrollService({
    db: appDb as unknown as Sql,
    ledger: new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" }),
    actor: { userId, tenantId, organizationId: orgId },
    crypto: new PayrollCrypto(new EnvKeyProvider({ key: masterKey })),
    env: opts.env ?? {},
    ...(opts.pack ? { pack: opts.pack } : {}),
  });

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Paie brouillon') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'p@t.t', 'P') RETURNING id`;
  userId = u!.id as string;
  tenantId = (
    await seedCompany(db, {
      organizationId: orgId,
      name: "SARL Paie",
      countryCode: "CI",
      currency: "XOF",
      packVersion: "ci@2025.1",
      fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
    })
  ).companyId;
  strict = makeService();
  preprod = makeService({ env: { ALLOW_INSECURE_DRAFT_PACK_FILINGS: "1" } });
});

afterAll(async () => {
  await env?.drop();
});

run("Paie sur un pack non publié", () => {
  it("le cycle de paie complet reste possible : c'est de la tenue, pas un dépôt", async () => {
    const e = await strict.createEmployee({
      matricule: "M001",
      firstName: "Awa",
      lastName: "Koné",
      hireDate: "2024-06-01",
      baseSalary: "500000",
      socialSecurityNumber: "1234567890",
      taxId: "CI-1234567-A",
    });
    employeeId = e.id;
    partnerId = e.partnerId;
    expect(e.taxId).toBe("CI-1234567-A");

    const created = await strict.createRun(2025, 3);
    runId = created.id;
    const { run: computed } = await strict.computeRun(runId);
    expect(computed.status).toBe("COMPUTED");
    const { run: validated, entryId } = await strict.validateRun(runId);
    expect(validated.status).toBe("VALIDATED");
    expect(entryId).toBeTruthy();
    const { run: paid } = await strict.payRun(runId, "521", "2025-04-05");
    expect(paid.status).toBe("PAID");
    expect((await strict.payrollBook(2025)).rows).toHaveLength(1);
  });

  it("le bulletin est produit, mais dit que le pack est un brouillon", async () => {
    const [payslip] = await strict.listPayslips(runId);
    const view = await strict.payslipView(payslip!.id);
    expect(view.official).toBe(false);
    expect(view.packNotice).toContain("ci@2025.1");
    expect(view.packNotice).toContain("DRAFT");
    expect(view.totals.gross).toBeTruthy();
    // Pack publié : plus de mention.
    const officialView = await makeService({ pack: published }).payslipView(payslip!.id);
    expect(officialView.official).toBe(true);
    expect(officialView.packNotice).toBeNull();
  });

  it("refuse les déclarations sociales et leur dépôt, en nommant le pack et le remède", async () => {
    await expect(strict.declarations({ year: 2025, month: 3 })).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
    await expect(strict.declarations({ year: 2025, month: 3 })).rejects.toThrowError(/ci@2025\.1/);
    await expect(strict.declarations({ year: 2025, month: 3 })).rejects.toThrowError(/ALLOW_INSECURE_DRAFT_PACK_FILINGS/);
    expect(await strict.listDeclarations({ year: 2025, month: 3 })).toEqual([]);
  });

  it("sous l'échappement, les déclarations sont produites et marquées non officielles", async () => {
    const declarations = await preprod.declarations({ year: 2025, month: 3 });
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.every((d) => d.official === false)).toBe(true);
    const filed = await preprod.fileDeclaration(declarations[0]!.id, "CNPS-PREPROD-1");
    expect(filed.status).toBe("FILED");
    expect(filed.official).toBe(false);
    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT official FROM payroll_declaration WHERE tenant_id = ${tenantId}`);
    expect(rows.every((r) => r.official === false)).toBe(true);
    // Sans échappement, le dépôt reste refusé même sur une déclaration existante.
    await expect(strict.fileDeclaration(declarations[0]!.id, "CNPS-2")).rejects.toMatchObject({ code: "PACK_NOT_PUBLISHED" });
  });
});

run("Identifiants fiscaux chiffrés au repos", () => {
  it("l'identifiant du salarié et celui de son tiers sont du chiffré, jamais du clair", async () => {
    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT tax_id, tax_id_enc FROM employee WHERE id = ${employeeId}`);
    expect(rows[0]!.tax_id).toBeNull();
    expect(String(rows[0]!.tax_id_enc)).toMatch(/^v2:1:/);

    const partner = await withTenant(db, { tenantId }, (tx) => tx`SELECT tax_id, tax_id_enc, tax_id_bidx FROM partner WHERE id = ${partnerId}`);
    expect(partner[0]!.tax_id).toBeNull();
    expect(String(partner[0]!.tax_id_enc)).toMatch(/^v2:1:/);
    expect(partner[0]!.tax_id_bidx).toBeTruthy();
    // Ni la valeur ni sa forme normalisée n'apparaissent en base.
    expect(JSON.stringify([rows, partner])).not.toMatch(/CI-1234567-A|CI1234567A/i);
  });

  it("la rotation de clé reprend l'identifiant fiscal comme le salaire", async () => {
    const before = await strict.getEmployee(employeeId);
    const result = await strict.rotateTenantKey();
    expect(result.version).toBe(2);
    expect(result.reencrypted).toBeGreaterThanOrEqual(2); // salarié + tiers
    const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT tax_id_enc FROM employee WHERE id = ${employeeId}`);
    expect(String(rows[0]!.tax_id_enc)).toMatch(/^v2:2:/);
    expect((await makeService().getEmployee(employeeId)).taxId).toBe(before.taxId);
  });
});
