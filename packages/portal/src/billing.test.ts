import { describe, expect, it } from "vitest";
import { computeDegressiveInvoice, parseTiers, unitPriceFor } from "./billing.js";

const tiers = [{ upTo: 5, price: "12000" }, { upTo: 20, price: "10000" }, { upTo: 50, price: "8000" }, { price: "6000" }];

describe("tarification dégressive", () => {
  it("trie et valide les paliers", () => {
    const sorted = parseTiers([{ price: "6000" }, { upTo: 5, price: 12000 }]);
    expect(sorted.map((t) => t.upTo)).toEqual([5, undefined]);
    expect(sorted[0]!.price).toBe("12000.0000");
    expect(() => parseTiers([{ price: "1" }, { upTo: 3, price: "2" }, { price: "3" }])).toThrow(/sans upTo/);
    expect(() => parseTiers([{ upTo: 5, price: "1" }, { upTo: 5, price: "2" }])).toThrow(/croissants/);
    expect(() => parseTiers([{ upTo: 5, price: "1.23456" }])).toThrow();
  });

  it("prix du palier atteint (volume)", () => {
    expect(unitPriceFor(1, tiers, "0").toString()).toBe("12000.0000");
    expect(unitPriceFor(5, tiers, "0").toString()).toBe("12000.0000");
    expect(unitPriceFor(6, tiers, "0").toString()).toBe("10000.0000");
    expect(unitPriceFor(51, tiers, "0").toString()).toBe("6000.0000");
    expect(unitPriceFor(3, [], "15000").toString()).toBe("15000.0000");
  });

  it("facture volume = dossiers × prix du palier", () => {
    const inv = computeDegressiveInvoice({ dossiers: 12, tiers, pricePerDossier: "12000" });
    expect(inv.unitPrice).toBe("10000.0000");
    expect(inv.total).toBe("120000.0000");
    expect(inv.lines).toHaveLength(1);
  });

  it("facture par tranches (tiered) : prix marginal", () => {
    const inv = computeDegressiveInvoice({ dossiers: 12, tiers, pricePerDossier: "12000", mode: "TIERED" });
    expect(inv.lines).toEqual([
      { from: 1, to: 5, count: 5, unitPrice: "12000.0000", amount: "60000.0000" },
      { from: 6, to: 12, count: 7, unitPrice: "10000.0000", amount: "70000.0000" },
    ]);
    expect(inv.total).toBe("130000.0000");
    expect(inv.unitPrice).toBe("10833.3333");
  });

  it("sans dossier ni palier", () => {
    expect(computeDegressiveInvoice({ dossiers: 0, tiers, pricePerDossier: "12000" })).toMatchObject({ total: "0.0000", unitPrice: null, lines: [] });
    expect(computeDegressiveInvoice({ dossiers: 3, tiers: [], pricePerDossier: "15000" }).total).toBe("45000.0000");
    expect(() => computeDegressiveInvoice({ dossiers: -1, tiers, pricePerDossier: "1" })).toThrow();
  });
});
