// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { Money, MoneyError, sum } from "./money.js";

describe("Money", () => {
  it("parse et sérialise à 4 décimales sans flottant", () => {
    expect(Money.parse("1234.5").toString()).toBe("1234.5000");
    expect(Money.parse("-12").toString()).toBe("-12.0000");
    expect(Money.parse("0.0001").toString()).toBe("0.0001");
    expect(Money.parse("1 000 000,25").toString()).toBe("1000000.2500");
  });

  it("refuse plus de 4 décimales et les chaînes invalides", () => {
    expect(() => Money.parse("1.00001")).toThrow(MoneyError);
    expect(() => Money.parse("abc")).toThrow(MoneyError);
    expect(() => Money.parse(Number.NaN)).toThrow(MoneyError);
  });

  it("additionne exactement là où les flottants dérivent", () => {
    const a = Money.parse("0.1");
    const b = Money.parse("0.2");
    expect(a.add(b).toString()).toBe("0.3000");
    expect(sum([a, b, Money.parse("0.3")]).toString()).toBe("0.6000");
  });

  it("applique un taux avec arrondi arithmétique", () => {
    expect(Money.parse("1000").mulRate("0.18").toString()).toBe("180.0000");
    expect(Money.parse("333.33").mulRate("0.18").toString()).toBe("59.9994");
    expect(Money.parse("1").mulRate("0.00005").toString()).toBe("0.0001");
  });

  it("formate selon la devise (XOF sans décimales, EUR à deux)", () => {
    expect(Money.parse("1234567.5").format("XOF")).toBe("1 234 568");
    expect(Money.parse("1234.5").format("EUR")).toBe("1 234.50");
    expect(Money.parse("-999").format("XOF")).toBe("-999");
  });

  it("compare et signe", () => {
    expect(Money.parse("5").cmp(Money.parse("3"))).toBe(1);
    expect(Money.parse("3").sub(Money.parse("5")).isNegative()).toBe(true);
    expect(Money.parse("-3").abs().toString()).toBe("3.0000");
  });
});
