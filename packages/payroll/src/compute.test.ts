// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { CountryPackSchema, loadPack } from "@arcompt/country-packs";
import { computePayslip, lastDayOfMonth, periodLabel } from "./compute.js";
import { PayrollError } from "./errors.js";
import { derivePayrollScheme } from "./scheme.js";

const ci = loadPack("ci");
const period = { year: 2025, month: 1 };

describe("derivePayrollScheme — découverte par convention", () => {
  it("trouve la CNPS (salarié/employeur, assiette, taux) et l'ITS dans le pack CI", () => {
    const scheme = derivePayrollScheme(ci);
    expect(scheme.packVersion).toBe("ci@2025.1");
    expect(scheme.currency).toBe("XOF");
    expect(scheme.contributions).toHaveLength(1);
    const cnps = scheme.contributions[0]!;
    expect(cnps).toMatchObject({
      id: "cnps",
      kind: "CNPS",
      label: "CNPS",
      employeeRuleId: "payroll.cnps.employee",
      employerRuleId: "payroll.cnps.employer",
      baseRuleId: "payroll.cnps.base",
      employeeRateRuleId: "payroll.cnps.retraite.employee_rate",
      employerRateRuleId: "payroll.cnps.retraite.employer_rate",
      account: "431",
    });
    expect(scheme.incomeTax).toMatchObject({ ruleId: "payroll.its", account: "447", kind: "ITS" });
    expect(scheme.netRuleId).toBe("payroll.net");
    expect(scheme.accounts).toEqual({ gross: "661", employerCharges: "664", advances: "421", netDue: "422", socialBody: "431", incomeTax: "447" });
  });

  it("accepte des sous-comptes propres au dossier", () => {
    const scheme = derivePayrollScheme(ci, { accounts: { incomeTax: "4471" }, contributionAccounts: { cnps: "4311" } });
    expect(scheme.incomeTax?.account).toBe("4471");
    expect(scheme.contributions[0]?.account).toBe("4311");
  });
});

describe("computePayslip — pack CI", () => {
  it("brut 500 000 : CNPS 31 500 / 38 500, ITS 74 385, net 394 115, coût employeur 538 500", () => {
    const p = computePayslip(ci, { baseSalary: "500000" }, period);
    expect(p.date).toBe("2025-01-31");
    expect(p.currency).toBe("XOF");
    expect(p.gross.toString()).toBe("500000.0000");
    expect(p.employeeContributions.toString()).toBe("31500.0000");
    expect(p.employerContributions.toString()).toBe("38500.0000");
    expect(p.taxableBase.toString()).toBe("468500.0000");
    expect(p.incomeTax.toString()).toBe("74385.0000");
    expect(p.net.toString()).toBe("394115.0000");
    expect(p.netToPay.toString()).toBe("394115.0000");
    expect(p.employerCost.toString()).toBe("538500.0000");
    expect(p.lines.map((l) => [l.id, l.kind, l.account])).toEqual([
      ["base", "EARNING", "661"],
      ["cnps", "CONTRIBUTION", "431"],
      ["its", "TAX", "447"],
    ]);
    const cnps = p.lines[1]!;
    expect(cnps).toMatchObject({ base: "500000.0000", rate: "0.063", employee_amount: "31500.0000", employer_amount: "38500.0000", rule_id: "payroll.cnps.employee" });
    expect(p.lines[2]).toMatchObject({ base: "468500.0000", rate: null, employee_amount: "74385.0000", rule_id: "payroll.its" });
  });

  it("plafonne l'assiette CNPS et arrondit à l'unité en XOF", () => {
    const p = computePayslip(ci, { baseSalary: "5000000" }, period);
    expect(p.lines.find((l) => l.id === "cnps")?.base).toBe("3375000.0000");
    expect(p.employeeContributions.toString()).toBe("212625.0000"); // 3 375 000 × 6,3 %
    const q = computePayslip(ci, { baseSalary: "123456.7" }, period);
    expect(q.gross.toString()).toBe("123457.0000");
  });

  it("intègre indemnités, heures sup., primes, absences et acompte ; les indemnités non soumises échappent aux règles", () => {
    const p = computePayslip(
      ci,
      { baseSalary: "450000", allowances: [{ code: "TRANSPORT", label: "Indemnité de transport", amount: "30000", taxable: false }, { code: "LOG", label: "Logement", amount: "50000" }] },
      period,
      { overtime: "20000", bonuses: [{ label: "Prime de rendement", amount: "10000" }], deductions: [{ label: "Absence 1 jour", amount: "30000" }], advance: "100000" },
    );
    // Brut versé = 450 000 + 30 000 + 50 000 + 20 000 + 10 000 − 30 000 = 530 000 ; brut soumis = 500 000.
    expect(p.gross.toString()).toBe("530000.0000");
    expect(p.employeeContributions.toString()).toBe("31500.0000");
    expect(p.incomeTax.toString()).toBe("74385.0000");
    expect(p.net.toString()).toBe("424115.0000"); // 394 115 + 30 000 non soumis
    expect(p.advance.toString()).toBe("100000.0000");
    expect(p.netToPay.toString()).toBe("324115.0000");
    expect(p.employerCost.toString()).toBe("568500.0000");
    expect(p.lines.filter((l) => l.kind === "EARNING").map((l) => l.id)).toEqual(["base", "allowance.TRANSPORT", "allowance.LOG", "overtime", "bonus.1"]);
    expect(p.lines.find((l) => l.kind === "DEDUCTION")).toMatchObject({ employee_amount: "30000.0000", account: "661" });
    expect(p.lines.find((l) => l.kind === "ADVANCE")).toMatchObject({ employee_amount: "100000.0000", account: "421" });
  });

  it("refuse les entrées invalides sans exposer de montants dans le message", () => {
    expect(() => computePayslip(ci, { baseSalary: "0" }, period)).toThrow(PayrollError);
    expect(() => computePayslip(ci, { baseSalary: "abc" }, period)).toThrowError(/Salaire de base/);
    expect(() => computePayslip(ci, { baseSalary: "100000" }, period, { advance: "5000000" })).toThrowError(/Acompte supérieur au net/);
    expect(() => computePayslip(ci, { baseSalary: "100000" }, period, { deductions: [{ label: "x", amount: "-1" }] })).toThrowError(/négatif/);
    try {
      computePayslip(ci, { baseSalary: "100000" }, period, { advance: "5000000" });
    } catch (e) {
      expect((e as PayrollError).message).not.toMatch(/\d{5}/);
    }
  });

  it("utilitaires de période", () => {
    expect(lastDayOfMonth(2024, 2)).toBe("2024-02-29");
    expect(lastDayOfMonth(2025, 12)).toBe("2025-12-31");
    expect(periodLabel(2025, 3)).toBe("mars 2025");
  });
});

describe("computePayslip — pack synthétique", () => {
  const base = {
    code: "zz",
    name: "Test",
    version: "2025.1",
    identity: { currency: "EUR", languages: ["fr"], tax_ids: [], accounting_systems: ["NORMAL"], social_security_body: "IPRES" },
    vat: { rates: [], rules: [] },
    taxes: { rules: [] },
    dsf: { label: "DSF", statements: [], adjustments: [] },
  };
  const rule = (id: string, expr: string, depends_on: string[] = []) => ({ id, expr, depends_on, valid_from: "2000-01-01" });

  it("découvre plusieurs cotisations, gère une cotisation patronale seule et arrondit à 2 décimales en EUR", () => {
    const pack = CountryPackSchema.parse({
      ...base,
      payroll: {
        variables: ["salaire_brut"],
        rules: [
          rule("payroll.ipres.employee", "salaire_brut * 0.056"),
          rule("payroll.ipres.employer", "salaire_brut * 0.084"),
          rule("payroll.css.employer", "salaire_brut * 0.07"),
          rule("payroll.its", "salaire_brut * 0.1", []),
        ],
      },
    });
    const scheme = derivePayrollScheme(pack);
    expect(scheme.contributions.map((c) => [c.id, c.label, c.employeeRuleId, c.employerRuleId])).toEqual([
      ["css", "CSS", null, "payroll.css.employer"],
      ["ipres", "IPRES", "payroll.ipres.employee", "payroll.ipres.employer"],
    ]);
    expect(scheme.netRuleId).toBeNull();
    const p = computePayslip(pack, { baseSalary: "1234.567" }, period);
    expect(p.gross.toString()).toBe("1234.5700");
    expect(p.employeeContributions.toString()).toBe("69.1400"); // 1234.57 × 0.056 = 69.13592
    expect(p.employerContributions.toString()).toBe("190.1200"); // 103.70388 + 86.4199
    expect(p.incomeTax.toString()).toBe("123.4600");
  });

  it("signale un net du pack incohérent avec les lignes du schéma", () => {
    const pack = CountryPackSchema.parse({
      ...base,
      payroll: {
        variables: ["salaire_brut"],
        rules: [rule("payroll.ipres.employee", "salaire_brut * 0.05"), rule("payroll.net", "salaire_brut - payroll.ipres.employee - 10", ["payroll.ipres.employee"])],
      },
    });
    expect(() => computePayslip(pack, { baseSalary: "1000" }, period)).toThrowError(/Net calculé différent/);
  });

  it("refuse un pack sans règle de paie", () => {
    const pack = CountryPackSchema.parse({ ...base, payroll: { variables: [], rules: [] } });
    expect(() => derivePayrollScheme(pack)).toThrowError(/aucune règle de paie/);
  });

  it("convertit une erreur de règle (variable manquante) en PayrollError RULE_ERROR", () => {
    const pack = CountryPackSchema.parse({ ...base, payroll: { variables: ["salaire_brut", "plafond"], rules: [rule("payroll.x.employee", "min(salaire_brut, plafond) * 0.1")] } });
    let code: string | undefined;
    try {
      computePayslip(pack, { baseSalary: "1000" }, period);
    } catch (e) {
      code = (e as PayrollError).code;
    }
    expect(code).toBe("RULE_ERROR");
    expect(computePayslip(pack, { baseSalary: "1000" }, period, { variables: { plafond: "500" } }).employeeContributions.toString()).toBe("50.0000");
  });
});
