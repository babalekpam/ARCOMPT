// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { barScale, flowsFromDocuments, weeksBelow } from "./forecast";

describe("barScale", () => {
  it("calcule une largeur en pour cent sur le plus grand montant absolu", () => {
    const s = barScale([
      { inflows: "1000.0000", outflows: "250.0000", closing: "-2000.0000" },
      { inflows: "0.0000", outflows: "500.0000", closing: "100.0000" },
    ]);
    expect(s.max).toBe("2000.0000");
    expect(s.widthOf("1000.0000")).toBe(50);
    expect(s.widthOf("-2000.0000")).toBe(100);
    expect(s.widthOf("250")).toBe(12);
    expect(s.widthOf("0")).toBe(0);
  });

  it("renvoie zéro partout quand tous les montants sont nuls", () => {
    const s = barScale([{ inflows: "0.0000", outflows: "0.0000", closing: "0.0000" }]);
    expect(s.max).toBe("0.0000");
    expect(s.widthOf("10")).toBe(0);
  });
});

describe("weeksBelow", () => {
  it("repère les semaines sous le seuil (zéro par défaut)", () => {
    const weeks = [
      { index: 0, closing: "100.0000" },
      { index: 1, closing: "-5.0000" },
      { index: 2, closing: "50.0000" },
    ];
    expect(weeksBelow(weeks)).toEqual([1]);
    expect(weeksBelow(weeks, "60")).toEqual([1, 2]);
    expect(weeksBelow(weeks, "  ")).toEqual([1]);
  });
});

describe("flowsFromDocuments", () => {
  it("garde les documents ouverts avec un reste positif, échéance ou date d'émission", () => {
    const flows = flowsFromDocuments(
      [
        { number: "F-1", partnerName: "Awa", dueDate: "2025-07-01", issueDate: "2025-06-01", outstanding: "1000.0000", status: "SENT" },
        { number: "F-2", partnerName: "Bob", dueDate: null, issueDate: "2025-06-10", outstanding: "50.0000", status: "PARTIALLY_PAID" },
        { number: "F-3", partnerName: "Cyr", dueDate: "2025-07-01", issueDate: "2025-06-01", outstanding: "0.0000", status: "SENT" },
        { number: "F-4", partnerName: "Dia", dueDate: "2025-07-01", issueDate: "2025-06-01", outstanding: "10.0000", status: "PAID" },
      ],
      ["SENT", "PARTIALLY_PAID"],
    );
    expect(flows).toEqual([
      { dueDate: "2025-07-01", amount: "1000.0000", label: "F-1 · Awa" },
      { dueDate: "2025-06-10", amount: "50.0000", label: "F-2 · Bob" },
    ]);
  });
});
