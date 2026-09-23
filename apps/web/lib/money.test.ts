// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { addAmounts, balanceSide, compareAmounts, formatAmount, fromMinor, negate, normalizeInput, subAmounts, toMinor } from "./money";

describe("money (chaînes, jamais de flottant)", () => {
  it("formate en XOF sans décimales avec séparateur de milliers", () => {
    expect(formatAmount("1234567.0000", "XOF", { thousands: " " })).toBe("1 234 567");
    expect(formatAmount("1234.5000", "XOF", { thousands: " " })).toBe("1 235"); // arrondi arithmétique
    expect(formatAmount("-5000000.0000", "XOF", { thousands: " " })).toBe("-5 000 000");
    expect(formatAmount("1234567.0000", "XOF")).toBe("1 234 567"); // espace fine insécable par défaut
  });

  it("formate en EUR avec deux décimales et virgule", () => {
    expect(formatAmount("1234.5000", "EUR", { thousands: " " })).toBe("1 234,50");
    expect(formatAmount("0.0050", "EUR")).toBe("0,01");
    expect(formatAmount("12.3456", "EUR", { decimal: "." })).toBe("12.35");
  });

  it("ponctue selon la langue de l'interface, pas selon la devise", () => {
    // Les décimales viennent de la devise, les séparateurs de la langue.
    expect(formatAmount("1234567.0000", "XOF", { locale: "en" })).toBe("1,234,567");
    expect(formatAmount("1234.5000", "EUR", { locale: "en" })).toBe("1,234.50");
    expect(formatAmount("1234.5000", "EUR", { locale: "fr" })).toBe("1\u202f234,50");
    expect(formatAmount("-5000.0000", "XOF", { locale: "en" })).toBe("-5,000");
    // Une ponctuation imposée reste prioritaire sur celle de la langue.
    expect(formatAmount("1234.5000", "EUR", { locale: "en", thousands: " ", decimal: "," })).toBe("1 234,50");
  });

  it("gère le tiret pour zéro et les valeurs vides", () => {
    expect(formatAmount("0.0000", "XOF", { dashForZero: true })).toBe("—");
    expect(formatAmount("0.0000", "XOF")).toBe("0");
    expect(formatAmount(null)).toBe("");
  });

  it("parse et ré-émet la forme canonique à 4 décimales", () => {
    expect(fromMinor(toMinor("1 200,50"))).toBe("1200.5000");
    expect(fromMinor(toMinor("1 200"))).toBe("1200.0000");
    expect(fromMinor(toMinor("-12"))).toBe("-12.0000");
    expect(() => toMinor("12.34567")).toThrow(/décimales/);
    expect(() => toMinor("abc")).toThrow(/invalide/);
  });

  it("additionne, soustrait et compare sans perte", () => {
    expect(addAmounts("0.1", "0.2")).toBe("0.3000");
    expect(subAmounts("1180000", "1000000")).toBe("180000.0000");
    expect(negate("5.0000")).toBe("-5.0000");
    expect(compareAmounts("118.0000", "118")).toBe(0);
    expect(compareAmounts("1", "2")).toBe(-1);
  });

  it("calcule le sens du solde", () => {
    expect(balanceSide("1180000", "1180000")).toEqual({ side: "D", amount: "0.0000" });
    expect(balanceSide("100", "472000")).toEqual({ side: "C", amount: "471900.0000" });
    expect(balanceSide("5000000", "0")).toEqual({ side: "D", amount: "5000000.0000" });
  });

  it("normalise une saisie utilisateur (positifs seulement)", () => {
    expect(normalizeInput(" 1 000 ")).toBe("1000.0000");
    expect(normalizeInput("0")).toBeNull();
    expect(normalizeInput("-5")).toBeNull();
    expect(normalizeInput("x")).toBeNull();
    expect(normalizeInput("")).toBeNull();
  });
});
