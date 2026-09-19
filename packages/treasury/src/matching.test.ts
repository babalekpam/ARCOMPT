import { describe, expect, it } from "vitest";
import { Money } from "@arcompt/ledger";
import { labelSimilarity, matchTransactions, normalizeLabel, type MatchCandidateLine, type MatchTransaction } from "./matching.js";

const tx = (id: string, date: string, amount: string, label: string, reference?: string): MatchTransaction => ({ id, date, amount: Money.parse(amount), label, reference: reference ?? null });
const line = (lineId: string, date: string, amount: string, label: string, entryLabel = "", reference?: string): MatchCandidateLine => ({ lineId, date, amount: Money.parse(amount), label, entryLabel, reference: reference ?? null });

describe("libellés", () => {
  it("normalise accents, casse et ponctuation", () => {
    expect(normalizeLabel("Règlement Client ALPHA – FAC-2025/001")).toEqual(["reglement", "client", "alpha", "fac", "2025", "001"]);
  });
  it("mesure le recouvrement des jetons significatifs, mots vides exclus", () => {
    expect(labelSimilarity("VIR SEPA CLIENT ALPHA", "Règlement Client Alpha")).toBe(1);
    expect(labelSimilarity("FRAIS TENUE DE COMPTE", "Loyer mars")).toBe(0);
    expect(labelSimilarity("VIR", "Règlement")).toBe(0);
    const partial = labelSimilarity("REMISE CHEQUE 12345 ALPHA", "Remise chèque n°12345");
    expect(partial).toBeGreaterThan(0.5);
    expect(partial).toBeLessThan(1);
  });
});

describe("matchTransactions", () => {
  it("apparie un montant exact à la même date, unique, même sans libellé commun", () => {
    const [d] = matchTransactions([tx("t1", "2025-03-05", "1180000", "VIR 00012345")], [line("l1", "2025-03-05", "1180000", "Encaissement")]);
    expect(d!.autoMatch).toBe(true);
    expect(d!.reason).toBe("MATCHED");
    expect(d!.best!.score).toBeGreaterThanOrEqual(0.9);
    expect(d!.best!.unique).toBe(true);
  });

  it("exige l'égalité stricte du montant et la fenêtre de dates", () => {
    const lines = [line("l1", "2025-03-05", "1180001", "Alpha"), line("l2", "2025-03-20", "1180000", "Alpha")];
    const [d] = matchTransactions([tx("t1", "2025-03-05", "1180000", "Alpha")], lines);
    expect(d!.reason).toBe("NO_CANDIDATE");
    const [wide] = matchTransactions([tx("t1", "2025-03-05", "1180000", "Alpha")], lines, { dateWindowDays: 15 });
    expect(wide!.autoMatch).toBe(true);
  });

  it("n'apparie jamais sous le seuil : écart de date sans libellé commun", () => {
    const [d] = matchTransactions([tx("t1", "2025-03-05", "5000", "OP 778899")], [line("l1", "2025-03-08", "5000", "Frais divers")]);
    expect(d!.reason).toBe("BELOW_THRESHOLD");
    expect(d!.autoMatch).toBe(false);
    expect(d!.candidates).toHaveLength(1);
    // Le même cas passe si le libellé confirme.
    const [ok] = matchTransactions([tx("t1", "2025-03-05", "5000", "FRAIS TENUE COMPTE MARS")], [line("l1", "2025-03-08", "5000", "Frais tenue de compte mars")]);
    expect(ok!.autoMatch).toBe(true);
  });

  it("laisse en attente les candidats ambigus (même montant, même date, mêmes libellés)", () => {
    const lines = [line("l1", "2025-03-12", "250000", "Remise chèques"), line("l2", "2025-03-12", "250000", "Remise chèques")];
    const ds = matchTransactions([tx("t1", "2025-03-12", "250000", "REMISE CHQ 12345"), tx("t2", "2025-03-12", "250000", "REMISE CHQ 12346")], lines);
    expect(ds.map((d) => d.reason)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(ds.every((d) => !d.autoMatch)).toBe(true);
    expect(ds[0]!.candidates).toHaveLength(2);
  });

  it("tranche l'ambiguïté quand un libellé ou une référence distingue les candidats", () => {
    const lines = [line("l1", "2025-03-12", "250000", "Remise chèque 12345 Alpha"), line("l2", "2025-03-12", "250000", "Remise chèque 12346 Gamma")];
    const ds = matchTransactions([tx("t1", "2025-03-12", "250000", "REMISE CHEQUE 12345"), tx("t2", "2025-03-12", "250000", "REMISE CHEQUE 12346")], lines);
    expect(ds.map((d) => [d.autoMatch, d.best?.lineId])).toEqual([
      [true, "l1"],
      [true, "l2"],
    ]);
  });

  it("n'attribue une ligne du grand livre qu'une seule fois", () => {
    const lines = [line("l1", "2025-03-05", "1000", "Vente Alpha")];
    const ds = matchTransactions([tx("t1", "2025-03-05", "1000", "ALPHA"), tx("t2", "2025-03-06", "1000", "ALPHA")], lines);
    expect(ds.filter((d) => d.autoMatch)).toHaveLength(1);
    expect(ds.find((d) => d.autoMatch)!.transactionId).toBe("t1");
    expect(ds.find((d) => !d.autoMatch)!.reason).toBe("AMBIGUOUS");
  });

  it("respecte un seuil plus strict", () => {
    const [d] = matchTransactions([tx("t1", "2025-03-05", "1000", "X")], [line("l1", "2025-03-05", "1000", "Y")], { threshold: 0.95 });
    expect(d!.reason).toBe("BELOW_THRESHOLD");
  });
});
