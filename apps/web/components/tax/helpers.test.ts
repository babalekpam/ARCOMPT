import { describe, expect, it } from "vitest";
import { deadlineTone, defaultRange, dsfExportHref, dsfQuery, parseIsComputation, parseVatComputation, returnTone } from "./helpers";

describe("tax helpers", () => {
  it("associe un ton aux statuts", () => {
    expect(deadlineTone("OVERDUE")).toBe("danger");
    expect(deadlineTone("DUE_SOON")).toBe("warning");
    expect(deadlineTone("DONE")).toBe("success");
    expect(deadlineTone("UPCOMING")).toBe("info");
    expect(returnTone("DRAFT")).toBe("neutral");
    expect(returnTone("FILED")).toBe("success");
  });

  it("relit un calcul de TVA stocké et rejette une forme inattendue", () => {
    const data = {
      periodFrom: "2025-01-01",
      periodTo: "2025-01-31",
      collected: [{ vatCode: "TVA18", rate: "0.18", base: "100.0000", amount: "18.0000" }],
      deductible: [],
      totalCollected: "18.0000",
      totalDeductible: "0.0000",
      net: "18.0000",
      previousCredit: "0.0000",
      amountDue: "18.0000",
      creditCarried: "0.0000",
    };
    expect(parseVatComputation(data)?.collected[0]?.vatCode).toBe("TVA18");
    expect(parseVatComputation({ collected: "x" })).toBeNull();
    expect(parseVatComputation(null)).toBeNull();
  });

  it("relit un calcul d'acomptes IS", () => {
    const c = parseIsComputation({ fiscalResult: "1.0000", turnover: "2.0000", isAmount: "0.2500", imfAmount: "0.0000", due: "0.2500", instalments: [{ n: 1, amount: "0.1250", dueDate: null }, { bad: true }] });
    expect(c?.instalments).toEqual([{ n: 1, amount: "0.1250", dueDate: null }]);
    expect(parseIsComputation({})).toBeNull();
  });

  it("construit la requête et le lien Excel de la DSF", () => {
    expect(dsfQuery({ reintegrations: "0", deductions: "0" })).toBe("");
    expect(dsfQuery({ reintegrations: "10.0000", deductions: "0", previousFiscalYear: "2024" })).toBe("reintegrations=10.0000&previousFiscalYear=2024");
    expect(dsfExportHref("2025", { reintegrations: "0", deductions: "5.0000" })).toBe("/api/proxy/tax/dsf/2025.xlsx?deductions=5.0000");
    expect(dsfExportHref("2025", { reintegrations: "0", deductions: "0" })).toBe("/api/proxy/tax/dsf/2025.xlsx");
  });

  it("propose une plage par défaut du 1er janvier à aujourd'hui", () => {
    expect(defaultRange(new Date("2025-06-15T10:00:00Z"))).toEqual({ from: "2025-01-01", to: "2025-06-15" });
  });
});
