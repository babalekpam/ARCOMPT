import { describe, expect, it } from "vitest";
import { listPackCodes, loadPack, packRules, PackError, validatePackData, vatRate } from "./index.js";

describe("packs pays", () => {
  it("liste et valide tous les packs livrés", () => {
    const codes = listPackCodes();
    expect(codes).toContain("ci");
    for (const code of codes) expect(() => loadPack(code)).not.toThrow();
  });

  it("le modèle _template est valide", () => {
    expect(validatePackData(JSON.parse(JSON.stringify(loadPack("_template"))))).toEqual([]);
  });

  it("refuse un pack sans identité ou avec une règle invalide", () => {
    expect(validatePackData({ code: "zz" }).length).toBeGreaterThan(0);
    const base = loadPack("ci");
    const broken = { ...base, taxes: { rules: [{ id: "x", expr: "foo + 1", valid_from: "2020-01-01" }] } };
    expect(validatePackData(broken)).toEqual(["x : variable « foo » non déclarée (payroll.variables ou depends_on)"]);
    const both = { ...base, taxes: { rules: [{ id: "x", expr: "1", value: "1", valid_from: "2020-01-01" }] } };
    expect(validatePackData(both).join(" ")).toMatch(/soit expr, soit value/);
    const published = { ...base, status: "PUBLISHED" };
    expect(validatePackData(published)).toEqual(["un pack PUBLISHED doit indiquer reviewed_by (expert-comptable du pays)"]);
  });

  it("évalue les règles du pack Côte d'Ivoire avec le moteur de règles", () => {
    const pack = loadPack("ci");
    const rules = packRules(pack);
    // IS 25 % sur 1 000 000 = 250 000 ; IMF 0,5 % sur 10 000 000 = 50 000 ; dû = 250 000.
    expect(rules.evaluate("is.due", "2025-06-30", { resultat_fiscal: "1000000", ca_annuel: "10000000" }).value.toString()).toBe("250000");
    // Déficit : IS = 0, IMF = 50 000.
    expect(rules.evaluate("is.due", "2025-06-30", { resultat_fiscal: "-200000", ca_annuel: "10000000" }).value.toString()).toBe("50000");
    // Paie : brut 500 000, CNPS salarié 6,3 % = 31 500 ; base ITS 468 500.
    const cnps = rules.evaluate("payroll.cnps.employee", "2025-01-31", { salaire_brut: "500000" }).value.toString();
    expect(cnps).toBe("31500");
    const its = rules.evaluate("payroll.its", "2025-01-31", { salaire_brut: "500000" }).value.toString();
    // 75 000 à 0 % + 165 000 à 16 % (26 400) + 228 500 à 21 % (47 985) = 74 385
    expect(its).toBe("74385");
    expect(rules.evaluate("payroll.net", "2025-01-31", { salaire_brut: "500000" }).value.toString()).toBe("394115");
    // Plafond CNPS : brut 5 000 000 → assiette 3 375 000.
    expect(rules.evaluate("payroll.cnps.base", "2025-01-31", { salaire_brut: "5000000" }).value.toString()).toBe("3375000");
  });

  it("choisit le taux de TVA valable à la date", () => {
    const pack = loadPack("ci");
    expect(vatRate(pack, "TVA18", "2025-03-01").rate).toBe("0.18");
    expect(() => vatRate(pack, "TVA99", "2025-03-01")).toThrow(PackError);
  });
});
