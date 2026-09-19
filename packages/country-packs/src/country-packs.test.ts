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

describe("tous les packs : attentes structurelles", () => {
  const DATE = "2025-06-30";
  const GROSS = 500000;
  const codes = listPackCodes();
  const num = (s: string) => Number(s);

  it.each(codes)("pack %s : chargement, validation et composants obligatoires", (code) => {
    const pack = loadPack(code);
    expect(validatePackData(JSON.parse(JSON.stringify(pack)))).toEqual([]);
    expect(pack.status).toBe("DRAFT");
    expect(pack.identity.currency).toMatch(/^X[AO]F$/);
    expect(pack.identity.tax_ids.length).toBeGreaterThan(0);
    expect(pack.vat.rates.some((r) => r.code === "EXO")).toBe(true);
    expect(pack.vat.rates.some((r) => num(String(r.rate)) > 0)).toBe(true);
    expect(pack.filing.length).toBeGreaterThan(0);
    for (const f of pack.filing) expect(f.api).toBe(false);
    expect(pack.calendar.length).toBeGreaterThan(0);
    const overrides = pack.chart_overrides.map((o) => o.number);
    expect(overrides).toContain("4471");
    expect(overrides).toContain("4311");
    const ids = packRules(pack).ids();
    for (const id of ["is.rate", "is.amount", "imf.amount", "is.due", "payroll.its.bareme", "payroll.its", "payroll.net"]) expect(ids).toContain(id);
    expect(ids.some((id) => /^payroll\.[a-z]+\.employee$/.test(id))).toBe(true);
    expect(ids.some((id) => /^payroll\.[a-z]+\.employer$/.test(id))).toBe(true);
    expect(ids.some((id) => /^payroll\.[a-z]+\.plafond$/.test(id))).toBe(true);
    expect(pack.notes.join(" ")).toMatch(/valid/i);
  });

  it.each(codes)("pack %s : paie sur un brut de 500 000", (code) => {
    const rules = packRules(loadPack(code));
    const scope = { salaire_brut: String(GROSS) };
    const its = num(rules.evaluate("payroll.its", DATE, scope).value.toString());
    const net = num(rules.evaluate("payroll.net", DATE, scope).value.toString());
    expect(its).toBeGreaterThan(0);
    expect(net).toBeGreaterThan(0);
    expect(net).toBeLessThan(GROSS);
    expect(net + its).toBeLessThan(GROSS); // il reste au moins une cotisation salariale
  });

  it.each(codes)("pack %s : impôt dû avec résultat fiscal positif et négatif", (code) => {
    const rules = packRules(loadPack(code));
    const ca = { ca_annuel: "10000000" };
    const imf = num(rules.evaluate("imf.amount", DATE, ca).value.toString());
    const profit = num(rules.evaluate("is.due", DATE, { ...ca, resultat_fiscal: "1000000" }).value.toString());
    const loss = num(rules.evaluate("is.due", DATE, { ...ca, resultat_fiscal: "-200000" }).value.toString());
    const isAmount = num(rules.evaluate("is.amount", DATE, { ...ca, resultat_fiscal: "1000000" }).value.toString());
    expect(imf).toBeGreaterThan(0);
    expect(isAmount).toBeGreaterThan(0);
    expect(profit).toBeGreaterThan(0);
    expect(profit).toBeGreaterThanOrEqual(imf);
    expect(profit).toBeGreaterThanOrEqual(isAmount);
    // En déficit l'IS est nul : l'impôt dû est exactement le minimum.
    expect(loss).toBe(imf);
  });

  it("pack cm : valeur calculée à la main (brut 500 000)", () => {
    // Hypothèses du pack (indicatives) : CNPS PVID salarié 4,2 % plafonné à 750 000 ;
    // base IRPP = brut × 70 % − CNPS − 500 000 / 12 ; barème annuel 10 / 15 / 25 / 35 % ; CAC 10 %.
    //   CNPS salarié      = 500 000 × 4,2 %                       = 21 000
    //   Base mensuelle    = 350 000 − 21 000 − 41 666,67          = 287 333,33
    //   Base annuelle     = 287 333,33 × 12                       = 3 448 000
    //   IRPP annuel       = 2 000 000 × 10 % + 1 000 000 × 15 % + 448 000 × 25 %
    //                     = 200 000 + 150 000 + 112 000            = 462 000
    //   IRPP mensuel      = 462 000 / 12                          = 38 500
    //   CAC 10 %          =                                         3 850
    //   payroll.its       = 38 500 + 3 850                        = 42 350
    //   CFC salarié 1 %   = 5 000 ; RAV (tranche 400 001–500 000) = 5 850
    //   payroll.net       = 500 000 − 21 000 − 42 350 − 5 000 − 5 850 = 425 800
    const rules = packRules(loadPack("cm"));
    const scope = { salaire_brut: "500000" };
    expect(rules.evaluate("payroll.cnps.employee", DATE, scope).value.toString()).toBe("21000");
    expect(rules.evaluate("payroll.irpp.principal", DATE, scope).value.toString()).toBe("38500");
    expect(rules.evaluate("payroll.its", DATE, scope).value.toString()).toBe("42350");
    expect(rules.evaluate("payroll.net", DATE, scope).value.toString()).toBe("425800");
    // IS : 1 000 000 × 30 % × 1,10 = 330 000 ; minimum 2,2 % × 10 000 000 = 220 000 → dû 330 000.
    expect(rules.evaluate("is.due", DATE, { resultat_fiscal: "1000000", ca_annuel: "10000000" }).value.toString()).toBe("330000");
    expect(vatRate(loadPack("cm"), "TVA1925", DATE).rate).toBe("0.1925");
  });
});
