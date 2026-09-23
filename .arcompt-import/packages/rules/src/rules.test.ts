// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { Decimal, evalBoolean, evalNumber, parse, referencedVariables, RuleError, type Bareme } from "./expression.js";
import { RuleSet } from "./ruleset.js";

const its: Bareme = {
  kind: "bareme",
  tranches: [
    { upTo: "50000", rate: "0" },
    { upTo: "130000", rate: "0.015" },
    { upTo: "200000", rate: "0.05" },
    { rate: "0.10" },
  ],
};

describe("expressions", () => {
  it("arithmétique exacte et précédence", () => {
    expect(evalNumber("1 + 2 * 3", {}).toString()).toBe("7");
    expect(evalNumber("(1 + 2) * 3", {}).toString()).toBe("9");
    expect(evalNumber("0.1 + 0.2", {}).toString()).toBe("0.3");
    expect(evalNumber("-x / 4", { x: "10" }).toString()).toBe("-2.5");
    expect(evalNumber("10 / 3", {}).toString()).toBe("3.3333333333");
  });

  it("comparaisons et logique", () => {
    expect(evalBoolean("ca > 50000000 and not exonere", { ca: "60000000", exonere: false })).toBe(true);
    expect(evalBoolean("a == b or c != 1", { a: 1, b: 2, c: 1 })).toBe(false);
    expect(evalNumber("if(base > 100, base * 0.18, 0)", { base: "200" }).toString()).toBe("36");
  });

  it("fonctions : min, max, round, pct", () => {
    expect(evalNumber("max(is, minimum)", { is: "120000", minimum: "300000" }).toString()).toBe("300000");
    expect(evalNumber("round(1234.5678, 2)", {}).toString()).toBe("1234.57");
    expect(evalNumber("round(1250, -3)", {}).toString()).toBe("1000");
    expect(evalNumber("round(1500, -3)", {}).toString()).toBe("2000");
    expect(evalNumber("floor(19.99)", {}).toString()).toBe("19");
    expect(evalNumber("pct(1000, 18)", {}).toString()).toBe("180");
  });

  it("tranche() applique un barème marginal", () => {
    expect(evalNumber("tranche(base, bareme)", { base: "40000", bareme: its }).toString()).toBe("0");
    // 50 000 à 0 % + 80 000 à 1,5 % = 1 200
    expect(evalNumber("tranche(base, bareme)", { base: "130000", bareme: its }).toString()).toBe("1200");
    // + 70 000 à 5 % = 3 500 ; + 100 000 à 10 % = 10 000 → 14 700
    expect(evalNumber("tranche(base, bareme)", { base: "300000", bareme: its }).toString()).toBe("14700");
    expect(evalNumber("taux_tranche(150000, bareme)", { bareme: its }).toString()).toBe("0.05");
  });

  it("refuse le code arbitraire : fonctions et variables inconnues, syntaxe invalide", () => {
    expect(() => evalNumber("process.exit(1)", {})).toThrow(RuleError);
    expect(() => evalNumber("x + 1", {})).toThrow(/Variable inconnue/);
    expect(() => parse("1 +")).toThrow(RuleError);
    expect(() => parse("1 ; 2")).toThrow(RuleError);
    expect(() => evalNumber("1 / 0", {})).toThrow(/Division par zéro/);
  });

  it("liste les variables référencées", () => {
    expect(referencedVariables("tranche(base_imposable, bareme_its) - if(charge_famille > 0, 500, 0)")).toEqual(["bareme_its", "base_imposable", "charge_famille"]);
  });
});

describe("RuleSet — versionnage temporel", () => {
  const rules = new RuleSet([
    { id: "vat.rate", value: "0.18", valid_from: "2000-01-01", valid_to: "2025-12-31" },
    { id: "vat.rate", value: "0.20", valid_from: "2026-01-01", source: "Loi de finances 2026 (fictive)" },
    { id: "vat.amount", expr: "round(base * vat.rate, 0)", depends_on: ["vat.rate"], valid_from: "2000-01-01" },
    { id: "payroll.its.bareme", value: its, valid_from: "2000-01-01" },
    { id: "payroll.its", expr: "round(tranche(base, payroll.its.bareme), 0)", depends_on: ["payroll.its.bareme"], valid_from: "2000-01-01" },
  ]);

  it("choisit la version applicable à la date de la période", () => {
    expect(rules.evaluate("vat.amount", "2025-06-30", { base: "1000" }).value.toString()).toBe("180");
    expect(rules.evaluate("vat.amount", "2026-03-31", { base: "1000" }).value.toString()).toBe("200");
    expect(rules.evaluate("vat.rate", "2026-03-31", {}).version.source).toMatch(/2026/);
  });

  it("évalue les dépendances (barèmes) et signale une règle sans version valide", () => {
    expect(rules.evaluate("payroll.its", "2025-01-01", { base: "300000" }).value.toString()).toBe("14700");
    expect(() => rules.evaluate("vat.rate", "1999-12-31")).toThrow(/aucune version valide/);
    expect(() => rules.evaluate("nope", "2025-01-01")).toThrow(/Règle inconnue/);
  });

  it("détecte les chevauchements de validité et les cycles", () => {
    const bad = new RuleSet([
      { id: "a", value: 1, valid_from: "2020-01-01" },
      { id: "a", value: 2, valid_from: "2021-01-01" },
      { id: "b", expr: "c + 1", depends_on: ["c"], valid_from: "2020-01-01" },
      { id: "c", expr: "b + 1", depends_on: ["b"], valid_from: "2020-01-01" },
    ]);
    expect(bad.validate()).toEqual(["a : les versions 2020-01-01 et 2021-01-01 se chevauchent"]);
    expect(() => bad.evaluate("b", "2022-01-01")).toThrow(/circulaire/);
  });

  it("Decimal : notation scientifique et arrondis", () => {
    expect(Decimal.of("1e3").toString()).toBe("1000");
    expect(Decimal.of("1.5e-2").toString()).toBe("0.015");
    expect(Decimal.of("2.5").round().toString()).toBe("3");
    expect(Decimal.of("-2.5").round().toString()).toBe("-3");
    expect(Decimal.of("-2.4").ceil().toString()).toBe("-2");
  });
});
