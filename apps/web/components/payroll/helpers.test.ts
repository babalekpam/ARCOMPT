// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { buildComputeInputs, emptyVariableRow, employeeName, isMasked, parseAmount, payslipDraftPack, periodLabel, rowFromInputs, runTone } from "./helpers";

describe("payroll helpers", () => {
  it("détecte les valeurs masquées", () => {
    expect(isMasked("***")).toBe(true);
    expect(isMasked("****1234")).toBe(true);
    expect(isMasked("150000.0000")).toBe(false);
    expect(isMasked(null)).toBe(false);
  });

  it("normalise les montants saisis", () => {
    expect(parseAmount("1 200,5")).toBe("1200.5000");
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("0", { allowZero: true })).toBe("0.0000");
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("-5", { allowNegative: true })).toBe("-5.0000");
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
  });

  it("libelle une période dans la langue", () => {
    expect(periodLabel(2025, 3, "fr")).toBe("mars 2025");
    expect(periodLabel(2025, 3, "en")).toBe("March 2025");
  });

  it("construit les variables de calcul en omettant les salariés sans saisie", () => {
    const rows = [
      { ...emptyVariableRow("a"), overtime: "10000", bonus: "5000", bonusLabel: "", absences: "2000", advance: "1000" },
      emptyVariableRow("b"),
      { ...emptyVariableRow("c"), advance: "oops" },
    ];
    const { inputs, invalid } = buildComputeInputs(rows, { bonus: "Prime", absences: "Absences" });
    expect(inputs).toEqual({
      a: { overtime: "10000.0000", bonuses: [{ label: "Prime", amount: "5000.0000" }], deductions: [{ label: "Absences", amount: "2000.0000" }], advance: "1000.0000" },
    });
    expect(invalid).toEqual(["c:advance"]);
  });

  it("pré-remplit une ligne depuis les variables d'un bulletin", () => {
    const row = rowFromInputs("a", { overtime: "10.0000", bonuses: [{ label: "13e mois", amount: "50.0000" }], deductions: [{ label: "Absences", amount: "3.0000" }], advance: "1.0000" });
    expect(row).toEqual({ employeeId: "a", overtime: "10.0000", bonusLabel: "13e mois", bonus: "50.0000", absences: "3.0000", advance: "1.0000" });
    expect(rowFromInputs("b", undefined)).toEqual(emptyVariableRow("b"));
  });

  it("associe un ton de badge au statut et formate le nom", () => {
    expect(runTone("DRAFT")).toBe("neutral");
    expect(runTone("COMPUTED")).toBe("info");
    expect(runTone("PAID")).toBe("success");
    expect(employeeName({ firstName: "Awa", lastName: "Diop" })).toBe("DIOP Awa");
  });

  it("nomme le pack d'un bulletin non officiel et se tait sinon", () => {
    const view = { company: { countryCode: "ci" }, run: { packVersion: "2025.1" } };
    expect(payslipDraftPack({ ...view, official: false, packNotice: "Pack ci@2025.1 au statut DRAFT…" })).toBe("CI 2025.1");
    // Une mention sans drapeau, ou un drapeau sans mention : la mention sort quand même.
    expect(payslipDraftPack({ ...view, official: true, packNotice: "Pack ci@2025.1 au statut DRAFT…" })).toBe("CI 2025.1");
    expect(payslipDraftPack({ ...view, official: false, packNotice: null })).toBe("CI 2025.1");
    expect(payslipDraftPack({ ...view, official: true, packNotice: null })).toBeNull();
    expect(payslipDraftPack({ ...view, official: true, packNotice: "   " })).toBeNull();
    // Champs absents (API plus ancienne) : rien à dire, on n'invente pas une alerte.
    expect(payslipDraftPack(view)).toBeNull();
  });
});
