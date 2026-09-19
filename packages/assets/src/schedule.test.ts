import { describe, expect, it } from "vitest";
import { Money, sum } from "@arcompt/ledger";
import { accruedPortion, addMonths, degressiveSchedule, fiscalYearStartFor, linearSchedule, monthsInclusive } from "./schedule.js";

describe("linearSchedule", () => {
  it("amortit sur la durée avec prorata en jours, la dernière période absorbant l'arrondi", () => {
    const plan = linearSchedule({ cost: "1200000", startDate: "2025-04-01", durationMonths: 36, currency: "XOF" });
    expect(plan.map((p) => p.periodEnd)).toEqual(["2025-12-31", "2026-12-31", "2027-12-31", "2028-12-31"]);
    // 400 000 × 275/365 = 301 369,86 → 301 370 (XOF sans décimales)
    expect(plan[0]!.dotation.toString()).toBe("301370.0000");
    expect(plan[0]!.fraction).toBe("275/365");
    expect(plan[1]!.dotation.toString()).toBe("400000.0000");
    expect(plan[2]!.dotation.toString()).toBe("400000.0000");
    expect(plan[3]!.dotation.toString()).toBe("98630.0000");
    expect(plan[3]!.activeTo).toBe("2028-03-31");
    expect(sum(plan.map((p) => p.dotation)).toString()).toBe("1200000.0000");
    expect(plan.at(-1)!.netBookValue.isZero()).toBe(true);
    expect(plan.at(-1)!.cumulative.toString()).toBe("1200000.0000");
  });

  it("gère le prorata en mois et la valeur résiduelle", () => {
    const plan = linearSchedule({ cost: "10000", residualValue: "1000", startDate: "2025-04-15", durationMonths: 60, currency: "EUR", prorata: "MONTHS" });
    // base 9 000, annuité 1 800 ; 9 mois la première année → 1 350
    expect(plan[0]!.dotation.toString()).toBe("1350.0000");
    expect(plan[0]!.fraction).toBe("9/12");
    expect(plan).toHaveLength(6);
    expect(plan.at(-1)!.dotation.toString()).toBe("450.0000");
    expect(plan.at(-1)!.activeTo).toBe("2030-03-31");
    expect(plan.at(-1)!.netBookValue.toString()).toBe("1000.0000");
  });

  it("arrondit selon la devise (2 décimales en EUR) et reste exact au total", () => {
    const plan = linearSchedule({ cost: "1000", startDate: "2025-01-01", durationMonths: 36, currency: "EUR" });
    expect(plan.map((p) => p.dotation.toString())).toEqual(["333.3300", "333.3300", "333.3400"]);
  });

  it("respecte une fin d'exercice décalée (30 juin)", () => {
    const plan = linearSchedule({ cost: "365000", startDate: "2025-01-01", durationMonths: 12, currency: "XOF", fiscalYearEnd: "06-30" });
    expect(plan.map((p) => [p.periodStart, p.periodEnd, p.dotation.toString()])).toEqual([
      ["2024-07-01", "2025-06-30", "181000.0000"], // 181 jours / 365
      ["2025-07-01", "2026-06-30", "184000.0000"],
    ]);
  });

  it("refuse les entrées incohérentes", () => {
    expect(() => linearSchedule({ cost: "100", residualValue: "200", startDate: "2025-01-01", durationMonths: 12, currency: "XOF" })).toThrow(/résiduelle/);
    expect(() => linearSchedule({ cost: "100", startDate: "2025-01-01", durationMonths: 0, currency: "XOF" })).toThrow(/Durée/);
  });
});

describe("degressiveSchedule", () => {
  it("applique le taux dégressif puis bascule en linéaire, sans écart d'arrondi", () => {
    // 5 ans : taux linéaire 20 % × 2 = 40 % ; acquisition au 1er janvier.
    const plan = degressiveSchedule({ cost: "1000000", startDate: "2025-01-01", durationMonths: 60, currency: "XOF" });
    expect(plan).toHaveLength(5);
    expect(plan.map((p) => p.dotation.toString())).toEqual(["400000.0000", "240000.0000", "144000.0000", "108000.0000", "108000.0000"]);
    expect(plan.at(-1)!.netBookValue.isZero()).toBe(true);
  });

  it("prorate la première annuité en mois et compte celle-ci comme une annuité", () => {
    const plan = degressiveSchedule({ cost: "100000", startDate: "2025-10-10", durationMonths: 36, currency: "XOF" });
    // 3 ans : 33,33 % × 1,5 = 50 % ; 3 mois → 12 500
    expect(plan).toHaveLength(3);
    expect(plan[0]!.dotation.toString()).toBe("12500.0000");
    expect(plan[1]!.dotation.toString()).toBe("43750.0000"); // 87 500 × 50 % = 43 750 (= 87 500 / 2 : bascule linéaire)
    expect(plan[2]!.dotation.toString()).toBe("43750.0000");
    expect(sum(plan.map((p) => p.dotation)).eq(Money.parse("100000"))).toBe(true);
  });

  it("respecte la valeur résiduelle", () => {
    const plan = degressiveSchedule({ cost: "1000", residualValue: "100", startDate: "2025-01-01", durationMonths: 48, currency: "EUR", coefficient: "1.5" });
    expect(plan.at(-1)!.netBookValue.toString()).toBe("100.0000");
    expect(sum(plan.map((p) => p.dotation)).toString()).toBe("900.0000");
  });
});

describe("utilitaires de dates", () => {
  it("borne le jour en fin de mois et calcule les mois inclus", () => {
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(monthsInclusive("2025-04-15", "2025-12-31")).toBe(9);
    expect(fiscalYearStartFor("2025-12-31")).toBe("2025-01-01");
    expect(fiscalYearStartFor("2025-06-30")).toBe("2024-07-01");
  });

  it("calcule la part acquise d'une annuité à une date intermédiaire", () => {
    const [first] = linearSchedule({ cost: "1200000", startDate: "2025-04-01", durationMonths: 36, currency: "XOF" });
    expect(accruedPortion(first!, "2025-03-31", "XOF").isZero()).toBe(true);
    expect(accruedPortion(first!, "2025-06-30", "XOF").toString()).toBe("99726.0000"); // 301 370 × 91/275
    expect(accruedPortion(first!, "2025-12-31", "XOF").toString()).toBe("301370.0000");
  });
});
