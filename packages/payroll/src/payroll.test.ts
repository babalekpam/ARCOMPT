import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { loadPack } from "@arcompt/country-packs";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, Money, PostgresStore, sum } from "@arcompt/ledger";
// `@arcompt/db` n'exporte pas encore "./testing" dans son package.json : import relatif.
import { createTestDatabase } from "../../db/src/testing.js";
import { computePayslip } from "./compute.js";
import { EnvKeyProvider, PayrollCrypto, PayrollCryptoError } from "./crypto.js";
import { PayrollError } from "./errors.js";
import { PayrollService, rotateTenantKey } from "./service.js";

/**
 * Tests d'intégration : persistance chiffrée, cycle complet (création →
 * calcul → validation → paiement), livre de paie, déclarations, rotation de
 * clé et isolation entre dossiers. Ignorés sans DATABASE_URL.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const masterKey = randomBytes(32);
const pack = loadPack("ci");

let db: Db;
let appDb: Db;
let orgId: string;
let userId: string;
let tenantA: string;
let tenantB: string;
let serviceA: PayrollService;
let serviceB: PayrollService;
let store: PostgresStore;

const makeService = (tenantId: string, opts: { key?: Buffer } = {}) =>
  new PayrollService({
    db: appDb as unknown as Sql,
    ledger: new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" }),
    actor: { userId, tenantId, organizationId: orgId },
    crypto: new PayrollCrypto(new EnvKeyProvider({ key: opts.key ?? masterKey })),
  });

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test paie') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'paie@t.t', 'Paie') RETURNING id`;
  userId = u!.id as string;
  const fiscalYear = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "SARL A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "SARL B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  serviceA = makeService(tenantA);
  serviceB = makeService(tenantB);
  store = new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId });
});

afterAll(async () => {
  await env?.drop();
});

// Attendus du pack CI (brouillon) : brut 500 000 → CNPS 31 500 / 38 500, ITS 74 385, net 394 115.
const emp2 = computePayslip(pack, { baseSalary: "300000" }, { year: 2025, month: 3 }, { advance: "50000" });

let employee1: string;
let employee2: string;
let runId: string;
let payrollEntryId: string;

run("Paie — salariés chiffrés au repos", () => {
  it("crée un salarié avec son tiers 422 ; salaire, RIB et numéro CNPS sont chiffrés en base", async () => {
    const e = await serviceA.createEmployee({
      matricule: "M001",
      firstName: "Awa",
      lastName: "Koné",
      hireDate: "2024-06-01",
      baseSalary: "500000",
      bankDetails: { bank: "SGBCI", iban: "CI93CI0000000000000000000001" },
      socialSecurityNumber: "1234567890",
      dependants: 2,
    });
    employee1 = e.id;
    expect(e.baseSalary).toBe("500000.0000");
    expect(e.bankDetails).toEqual({ bank: "SGBCI", iban: "CI93CI0000000000000000000001" });
    expect(e.socialSecurityNumber).toBe("1234567890");
    expect(e.active).toBe(true);

    const rows = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT base_salary_enc, bank_details_enc, social_security_number_enc FROM employee WHERE id = ${e.id}`);
    for (const col of ["base_salary_enc", "bank_details_enc", "social_security_number_enc"] as const) {
      expect(rows[0]![col]).toMatch(/^v2:1:/);
    }
    expect(JSON.stringify(rows)).not.toMatch(/500000|SGBCI|1234567890/);
    const partner = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT type, name, collective_account FROM partner WHERE id = ${e.partnerId}`);
    expect(partner[0]).toEqual({ type: "EMPLOYEE", name: "KONÉ Awa", collective_account: "422" });
    const keys = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT version, status, master_key_id FROM payroll_tenant_key`);
    expect(keys).toEqual([{ version: 1, status: "ACTIVE", master_key_id: serviceA["crypto"].masterKeyId }]);

    const e2 = await serviceA.createEmployee({ matricule: "M002", firstName: "Moussa", lastName: "Diabaté", hireDate: "2025-02-15", baseSalary: "300000", contractType: "CDD" });
    employee2 = e2.id;
    await expect(serviceA.createEmployee({ matricule: "M002", firstName: "X", lastName: "Y", hireDate: "2025-01-01", baseSalary: "1" })).rejects.toMatchObject({ code: "MATRICULE_TAKEN" });
    await expect(serviceA.createEmployee({ matricule: "M003", firstName: "X", lastName: "Y", hireDate: "2025-01-01", baseSalary: "-5" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("met à jour un salarié ; la piste d'audit ne contient jamais les données sensibles", async () => {
    const updated = await serviceA.updateEmployee(employee1, { category: "Cadre", allowances: [{ code: "TRANSPORT", label: "Transport", amount: "0" }] });
    expect(updated.category).toBe("Cadre");
    expect(updated.baseSalary).toBe("500000.0000");
    const audit = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT action, before, after FROM audit_log WHERE entity = 'employee'`);
    expect(audit.map((a) => a.action).sort()).toEqual(["employee.create", "employee.create", "employee.update"]);
    expect(JSON.stringify(audit)).not.toMatch(/500000|SGBCI|1234567890|CI93/);
    const inactive = await serviceA.deactivateEmployee(employee2, "2025-12-31");
    expect(inactive.active).toBe(false);
    await serviceA.updateEmployee(employee2, { active: true });
    expect((await serviceA.listEmployees({ active: true })).map((e) => e.matricule)).toEqual(["M002", "M001"]);
  });
});

run("Paie — cycle mensuel", () => {
  it("crée et calcule le cycle de mars 2025 pour les salariés actifs", async () => {
    const created = await serviceA.createRun(2025, 3);
    runId = created.id;
    expect(created).toMatchObject({ status: "DRAFT", packVersion: "ci@2025.1", employeeCount: 0 });
    await expect(serviceA.createRun(2025, 3)).rejects.toMatchObject({ code: "RUN_EXISTS" });
    await expect(serviceA.validateRun(runId)).rejects.toMatchObject({ code: "RUN_STATUS" });
    await expect(serviceA.computeRun(runId, { [randomUUID()]: { advance: "1" } })).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });

    const { run: computed, payslips } = await serviceA.computeRun(runId, { [employee2]: { advance: "50000" } });
    expect(computed.status).toBe("COMPUTED");
    expect(computed.employeeCount).toBe(2);
    expect(computed.totalGross).toBe("800000.0000");
    expect(computed.totalEmployerContributions).toBe("61600.0000");
    expect(payslips).toHaveLength(2);
    const p1 = payslips.find((p) => p.employeeId === employee1)!;
    expect(p1).toMatchObject({ gross: "500000.0000", employeeContributions: "31500.0000", employerContributions: "38500.0000", incomeTax: "74385.0000", net: "394115.0000", netToPay: "394115.0000", employerCost: "538500.0000" });
    expect(p1.lines.map((l) => l.id)).toEqual(["base", "cnps", "its"]);
    const p2 = payslips.find((p) => p.employeeId === employee2)!;
    expect(p2.netToPay).toBe(emp2.netToPay.toString());
    expect(p2.advance).toBe("50000.0000");
    expect(p2.inputs).toEqual({ advance: "50000" });
    expect(computed.totalNet).toBe(Money.parse("394115").add(emp2.netToPay).toString());
    // Recalcul possible tant que le cycle n'est pas validé : les bulletins sont remplacés, pas dupliqués.
    const again = await serviceA.computeRun(runId, { [employee2]: { advance: "50000" } });
    expect(again.payslips).toHaveLength(2);
  });

  it("valide le cycle : une seule écriture PA équilibrée 661/664 à 422/421/431/447", async () => {
    const { run: validated, entryId } = await serviceA.validateRun(runId);
    payrollEntryId = entryId;
    expect(validated.status).toBe("VALIDATED");
    expect(validated.entryId).toBe(entryId);
    const entry = (await store.getEntry(tenantA, entryId))!;
    expect(entry.status).toBe("VALIDATED");
    expect(entry.journalCode).toBe("PA");
    expect(entry.source).toBe("PAYROLL");
    expect(entry.date).toBe("2025-03-31");
    expect(entry.reference).toBe("PAIE-2025-03");
    const e1 = await serviceA.getEmployee(employee1);
    const e2 = await serviceA.getEmployee(employee2);
    const lines = entry.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString(), l.partnerId]);
    expect(lines).toEqual([
      ["661", "800000.0000", "0.0000", null],
      ["664", "61600.0000", "0.0000", null],
      ["422", "0.0000", emp2.netToPay.toString(), e2.partnerId],
      ["421", "0.0000", "50000.0000", e2.partnerId],
      ["422", "0.0000", "394115.0000", e1.partnerId],
      ["431", "0.0000", "112000.0000", null],
      ["447", "0.0000", Money.parse("74385").add(emp2.incomeTax).toString(), null],
    ]);
    expect(sum(entry.lines.map((l) => l.debit)).eq(sum(entry.lines.map((l) => l.credit)))).toBe(true);
    await expect(serviceA.validateRun(runId)).rejects.toMatchObject({ code: "RUN_STATUS" });
    await expect(serviceA.computeRun(runId)).rejects.toMatchObject({ code: "RUN_STATUS" });
  });

  it("paie les salaires : 422 soldé par salarié, trésorerie créditée", async () => {
    await expect(serviceA.payRun(runId, "621", "2025-04-05")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const { run: paid, entryId } = await serviceA.payRun(runId, "521", "2025-04-05");
    expect(paid.status).toBe("PAID");
    expect(paid.paymentEntryId).toBe(entryId);
    expect(entryId).not.toBe(payrollEntryId);
    const entry = (await store.getEntry(tenantA, entryId))!;
    expect(entry.journalCode).toBe("BQ");
    expect(entry.lines.filter((l) => l.accountNumber === "422").every((l) => l.partnerId !== null && l.credit.isZero())).toBe(true);
    const tb = await serviceA["ledger"].trialBalance(tenantA, { fiscalYearCode: "2025" });
    const row422 = tb.rows.find((r) => r.accountNumber === "422")!;
    expect(row422.debit.eq(row422.credit)).toBe(true);
    expect(row422.debit.toString()).toBe(paid.totalNet);
    expect(tb.rows.find((r) => r.accountNumber === "521")!.credit.toString()).toBe(paid.totalNet);
    expect(tb.rows.find((r) => r.accountNumber === "421")!.credit.toString()).toBe("50000.0000");
    await expect(serviceA.payRun(runId, "521", "2025-04-06")).rejects.toMatchObject({ code: "RUN_STATUS" });
  });

  it("livre de paie de l'exercice et déclarations CNPS / ITS de la période", async () => {
    const book = await serviceA.payrollBook(2025);
    expect(book.currency).toBe("XOF");
    expect(book.rows.map((r) => [r.matricule, r.month, r.gross, r.runStatus])).toEqual([
      ["M002", 3, "300000.0000", "PAID"],
      ["M001", 3, "500000.0000", "PAID"],
    ]);
    expect(book.months).toEqual([{ month: 3, employees: 2, gross: "800000.0000", employeeContributions: "50400.0000", employerContributions: "61600.0000", incomeTax: Money.parse("74385").add(emp2.incomeTax).toString(), net: Money.parse("394115").add(emp2.net).toString(), employerCost: "861600.0000" }]);
    expect(book.totals.gross).toBe("800000.0000");
    expect((await serviceA.payrollBook(2024)).rows).toEqual([]);

    const decl = await serviceA.declarations({ year: 2025, month: 3 });
    expect(decl.map((d) => [d.kind, d.base, d.employeeAmount, d.employerAmount, d.amount, d.account, d.status])).toEqual([
      ["CNPS", "800000.0000", "50400.0000", "61600.0000", "112000.0000", "431", "DRAFT"],
      ["ITS", Money.parse("468500").add(emp2.taxableBase).toString(), Money.parse("74385").add(emp2.incomeTax).toString(), "0.0000", Money.parse("74385").add(emp2.incomeTax).toString(), "447", "DRAFT"],
    ]);
    const filed = await serviceA.fileDeclaration(decl[0]!.id, "CNPS-2025-03-0001");
    expect(filed).toMatchObject({ status: "FILED", filingReference: "CNPS-2025-03-0001" });
    // Une déclaration déposée n'est plus recalculée.
    const after = await serviceA.declarations({ year: 2025, month: 3 });
    expect(after.find((d) => d.kind === "CNPS")).toMatchObject({ status: "FILED", filingReference: "CNPS-2025-03-0001" });
    await expect(serviceA.declarations({ year: 2025, month: 4 })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("prépare les données du bulletin pour le rendu", async () => {
    const payslips = await serviceA.listPayslips(runId);
    const view = await serviceA.payslipView(payslips.find((p) => p.employeeId === employee1)!.id);
    expect(view.run).toMatchObject({ year: 2025, month: 3, status: "PAID", periodLabel: "mars 2025" });
    expect(view.company).toMatchObject({ name: "SARL A", countryCode: "CI", currency: "XOF" });
    expect(view.employee).toMatchObject({ matricule: "M001", fullName: "KONÉ Awa", category: "Cadre", socialSecurityNumber: "1234567890" });
    expect(view.sections.earnings.map((l) => l.formatted)).toEqual(["500 000"]);
    expect(view.sections.contributions[0]).toMatchObject({ formatted: "31 500", formattedEmployer: "38 500" });
    expect(view.totals).toMatchObject({ gross: "500 000", incomeTax: "74 385", netToPay: "394 115", employerCost: "538 500" });
    await expect(serviceA.payslipView(randomUUID())).rejects.toMatchObject({ code: "PAYSLIP_NOT_FOUND" });
  });
});

run("Paie — rotation de clé et isolation", () => {
  it("fait tourner la clé de données du dossier et re-chiffre les salariés", async () => {
    const result = await rotateTenantKey({
      db: appDb as unknown as Sql,
      ledger: serviceA["ledger"],
      actor: { userId, tenantId: tenantA, organizationId: orgId },
      crypto: new PayrollCrypto(new EnvKeyProvider({ key: masterKey })),
    });
    expect(result).toEqual({ version: 2, previousVersion: 1, reencrypted: 2 });
    const keys = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT version, status FROM payroll_tenant_key ORDER BY version`);
    expect(keys).toEqual([
      { version: 1, status: "RETIRED" },
      { version: 2, status: "ACTIVE" },
    ]);
    const rows = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT base_salary_enc FROM employee`);
    expect(rows.every((r) => String(r.base_salary_enc).startsWith("v2:2:"))).toBe(true);
    // Un service neuf (cache vide) et l'ancien service (jeu de clés rechargé à la volée) lisent tous deux les nouvelles données.
    expect((await makeService(tenantA).getEmployee(employee1)).baseSalary).toBe("500000.0000");
    expect((await serviceA.getEmployee(employee1)).socialSecurityNumber).toBe("1234567890");
    // Une écriture par l'ancien service chiffre avec la version active, pas avec sa version en cache.
    await serviceA.updateEmployee(employee2, { category: "Employé" });
    const rowsAfter = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT base_salary_enc FROM employee WHERE id = ${employee2}`);
    expect(String(rowsAfter[0]!.base_salary_enc)).toMatch(/^v2:2:/);
    // Sans la bonne clé maître, rien n'est lisible.
    await expect(makeService(tenantA, { key: randomBytes(32) }).getEmployee(employee1)).rejects.toThrow(PayrollCryptoError);
  });

  it("le dossier B ne voit ni les salariés, ni les cycles, ni les clés du dossier A (RLS)", async () => {
    expect(await serviceB.listEmployees()).toEqual([]);
    await expect(serviceB.getEmployee(employee1)).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    await expect(serviceB.getRun(runId)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect(await serviceB.listRuns()).toEqual([]);
    expect((await serviceB.payrollBook(2025)).rows).toEqual([]);
    const seen = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`
      SELECT (SELECT count(*)::int FROM employee) AS employees, (SELECT count(*)::int FROM payslip) AS payslips, (SELECT count(*)::int FROM payroll_tenant_key) AS keys`);
    expect(seen[0]).toEqual({ employees: 0, payslips: 0, keys: 0 });
    await expect(
      withTenant(appDb, { tenantId: tenantB }, (tx) => tx`INSERT INTO payroll_run (tenant_id, year, month, pack_version, created_by) VALUES (${tenantA}, 2025, 5, 'ci@2025.1', ${userId})`),
    ).rejects.toThrow(/row-level security/);
    expect(await appDb`SELECT count(*)::int AS n FROM employee`).toEqual([{ n: 0 }]);
    // Le dossier B a son propre cycle, sans salarié actif.
    const runB = await serviceB.createRun(2025, 3);
    await expect(serviceB.computeRun(runB.id)).rejects.toMatchObject({ code: "RUN_EMPTY" });
    expect(serviceB["crypto"]).toBeDefined();
    expect(PayrollError.name).toBe("PayrollError");
  });
});
