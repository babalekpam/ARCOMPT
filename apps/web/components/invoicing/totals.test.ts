import { describe, expect, it } from "vitest";
import { findVatRate, mulRateMinor, parseRate, previewTotals, roundMinor, sumAllocations } from "./totals";
import type { PackVatRate } from "./types";

const rates: PackVatRate[] = [
  { code: "TVA18", label: "Normal", rate: "0.18", valid_from: "2000-01-01" },
  { code: "TVA9", label: "Réduit", rate: "0.09", valid_from: "2000-01-01" },
  { code: "EXO", label: "Exonéré", rate: "0", valid_from: "2000-01-01" },
  { code: "OLD", label: "Ancien", rate: "0.20", valid_from: "2000-01-01", valid_to: "2010-12-31" },
];

describe("previewTotals", () => {
  it("calcule HT × quantité, TVA et TTC en XOF (0 décimale) comme le serveur", () => {
    const p = previewTotals([{ quantity: "3", unitPrice: "1000", vatCode: "TVA18" }], { rates, currency: "XOF", date: "2025-06-01" });
    expect(p.valid).toBe(true);
    expect(p.lines[0]).toEqual({ net: "3000.0000", vatRate: "0.18", vat: "540.0000", gross: "3540.0000", unknownVatCode: false });
    expect(p.totalNet).toBe("3000.0000");
    expect(p.totalVat).toBe("540.0000");
    expect(p.totalGross).toBe("3540.0000");
    expect(p.byVatCode).toEqual([{ vatCode: "TVA18", rate: "0.18", base: "3000.0000", vat: "540.0000" }]);
  });

  it("arrondit aux décimales de la devise (XOF : demi vers le haut)", () => {
    // 3 × 33.5 = 100.5 → 101 ; TVA 18 % de 101 = 18.18 → 18
    const p = previewTotals([{ quantity: "3", unitPrice: "33.5", vatCode: "TVA18" }], { rates, currency: "XOF", date: "2025-06-01" });
    expect(p.lines[0]?.net).toBe("101.0000");
    expect(p.lines[0]?.vat).toBe("18.0000");
    // En EUR : 100.50 reste, TVA 18.09
    const e = previewTotals([{ quantity: "3", unitPrice: "33.5", vatCode: "TVA18" }], { rates, currency: "EUR", date: "2025-06-01" });
    expect(e.lines[0]?.net).toBe("100.5000");
    expect(e.lines[0]?.vat).toBe("18.0900");
  });

  it("accepte un HT direct (achats), une quantité par défaut de 1 et une virgule décimale", () => {
    const p = previewTotals([{ net: "2 500,5", vatCode: "TVA9" }, { unitPrice: "10" }], { rates, currency: "EUR", date: "2025-06-01" });
    expect(p.lines[0]?.net).toBe("2500.5000");
    expect(p.lines[0]?.vat).toBe("225.0500");
    expect(p.lines[1]).toEqual({ net: "10.0000", vatRate: "0", vat: "0.0000", gross: "10.0000", unknownVatCode: false });
    expect(p.totalGross).toBe("2735.5500");
  });

  it("agrège le récapitulatif par code dans l'ordre d'apparition", () => {
    const p = previewTotals(
      [
        { net: "100", vatCode: "TVA18" },
        { net: "50", vatCode: "EXO" },
        { net: "200", vatCode: "TVA18" },
      ],
      { rates, currency: "XOF", date: "2025-06-01" },
    );
    expect(p.byVatCode.map((r) => r.vatCode)).toEqual(["TVA18", "EXO"]);
    expect(p.byVatCode[0]).toEqual({ vatCode: "TVA18", rate: "0.18", base: "300.0000", vat: "54.0000" });
    expect(p.totalVat).toBe("54.0000");
  });

  it("signale les saisies illisibles et les codes TVA inconnus ou hors validité", () => {
    const bad = previewTotals([{ unitPrice: "abc" }], { rates, currency: "XOF", date: "2025-06-01" });
    expect(bad.valid).toBe(false);
    expect(bad.totalNet).toBe("0.0000");
    const unknown = previewTotals([{ net: "100", vatCode: "TVA99" }], { rates, currency: "XOF", date: "2025-06-01" });
    expect(unknown.valid).toBe(false);
    expect(unknown.lines[0]?.unknownVatCode).toBe(true);
    const expired = previewTotals([{ net: "100", vatCode: "OLD" }], { rates, currency: "XOF", date: "2025-06-01" });
    expect(expired.valid).toBe(false);
    expect(previewTotals([{ net: "100", vatCode: "OLD" }], { rates, currency: "XOF", date: "2005-06-01" }).lines[0]?.vat).toBe("20.0000");
  });

  it("gère l'absence de TVA (null) et la quantité invalide", () => {
    const p = previewTotals([{ net: "100", vatCode: null }], { rates, currency: "XOF", date: "2025-06-01" });
    expect(p.valid).toBe(true);
    expect(p.byVatCode).toEqual([]);
    expect(previewTotals([{ quantity: "1.23456", unitPrice: "10" }], { rates, currency: "XOF", date: "2025-06-01" }).valid).toBe(false);
  });
});

describe("arithmétique des taux", () => {
  it("parse les taux et multiplie sans flottant", () => {
    expect(parseRate("0.18")).toBe(1800000000n);
    expect(parseRate(18)).toBe(180000000000n);
    expect(mulRateMinor(1000000n, "0.18")).toBe(180000n);
    expect(mulRateMinor(1005000n, "3")).toBe(3015000n);
    expect(roundMinor(1005000n, 0)).toBe(1010000n);
    expect(roundMinor(1004999n, 0)).toBe(1000000n);
    expect(roundMinor(1005000n, 2)).toBe(1005000n);
  });

  it("sélectionne un taux par code et date", () => {
    expect(findVatRate(rates, "TVA18", "2025-01-01")?.rate).toBe("0.18");
    expect(findVatRate(rates, "OLD", "2025-01-01")).toBeNull();
    expect(findVatRate(rates, null, "2025-01-01")).toBeNull();
    expect(findVatRate(rates, "NOPE", "2025-01-01")).toBeNull();
  });
});

describe("sumAllocations", () => {
  it("additionne les affectations et ignore les vides", () => {
    expect(sumAllocations(["100", "", "50.5"])).toBe("150.5000");
    expect(sumAllocations([])).toBe("0.0000");
    expect(sumAllocations(["x"])).toBeNull();
  });
});
