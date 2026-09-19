import { describe, expect, it } from "vitest";
import { parseMobileMoneySms, parseMobileMoneySmsBatch, smsToRows } from "./sms.js";

describe("parseMobileMoneySms", () => {
  it("lit une réception Orange Money : montant, tiers, référence, solde, date", () => {
    const sms = "Vous avez reçu 25 000 FCFA de KOUAME YAO (0707070707) le 15/09/2025 à 14:32. Ref: PP250915.1432.A12345. Nouveau solde: 125 000 FCFA.";
    expect(parseMobileMoneySms(sms)).toMatchObject({
      direction: "IN",
      amount: "25000.0000",
      counterparty: "KOUAME YAO",
      reference: "PP250915.1432.A12345",
      balance: "125000.0000",
      date: "2025-09-15",
    });
  });

  it("lit un envoi avec frais", () => {
    const sms = "Vous avez envoyé 10 000 FCFA à 0505050505 AKISSI ADJOUA. Frais: 100 FCFA. Ref: TX987654321. Solde: 14 900 FCFA";
    const parsed = parseMobileMoneySms(sms)!;
    expect(parsed.direction).toBe("OUT");
    expect(parsed.amount).toBe("-10000.0000");
    expect(parsed.fee).toBe("100.0000");
    expect(parsed.counterparty).toBe("0505050505 AKISSI ADJOUA");
    expect(parsed.reference).toBe("TX987654321");
    expect(parsed.date).toBeUndefined();
  });

  it("lit les variantes anglaises (MTN), les retraits et les paiements marchands", () => {
    expect(parseMobileMoneySms("You have received 25,000 FCFA from JOHN DOE. Transaction Id: 1234567890. Your new balance is 30,000 FCFA.")).toMatchObject({
      direction: "IN",
      amount: "25000.0000",
      counterparty: "JOHN DOE",
      reference: "1234567890",
    });
    expect(parseMobileMoneySms("Retrait de 20 000 FCFA effectué le 03/09/2025 chez POINT CASH COCODY. Ref: RT001122. Solde: 5 000 FCFA")).toMatchObject({
      direction: "OUT",
      amount: "-20000.0000",
      date: "2025-09-03",
    });
    expect(parseMobileMoneySms("Paiement de 15 000F à MARCHAND SUPERMARCHE effectué avec succès. Ref: PM555")).toMatchObject({ direction: "OUT", amount: "-15000.0000", counterparty: "MARCHAND SUPERMARCHE" });
  });

  it("refuse un SMS sans sens ou sans montant en devise", () => {
    expect(parseMobileMoneySms("Votre code de confirmation est 123456")).toBeNull();
    expect(parseMobileMoneySms("Vous avez reçu un message")).toBeNull();
    expect(parseMobileMoneySms("")).toBeNull();
  });
});

describe("smsToRows / lot", () => {
  it("produit la ligne principale puis les frais, avec identifiants externes", () => {
    const rows = smsToRows(parseMobileMoneySms("Vous avez envoyé 10 000 FCFA à AKISSI le 15/09/2025. Frais: 100 FCFA. Ref: TX1")!);
    expect(rows).toEqual([
      { date: "2025-09-15", label: "Mobile money envoyé à AKISSI", amount: "-10000.0000", reference: "TX1", externalId: "TX1" },
      { date: "2025-09-15", label: "Frais mobile money (TX1)", amount: "-100.0000", reference: "TX1", externalId: "TX1-FEE" },
    ]);
  });

  it("lit un lot séparé par des lignes vides, applique la date par défaut, rapporte l'illisible", () => {
    const text = ["Vous avez reçu 5 000 FCFA de A. Ref: R1", "", "Code promo: 1234", "", "Vous avez envoyé 2 000 FCFA à B le 01/09/2025. Ref: R2"].join("\n");
    const { rows, unparsed } = parseMobileMoneySmsBatch(text, { defaultDate: "2025-09-10", includeFees: false });
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ["2025-09-10", "5000.0000"],
      ["2025-09-01", "-2000.0000"],
    ]);
    expect(unparsed).toEqual(["Code promo: 1234"]);
    // Sans date par défaut, un SMS sans date n'est pas importé.
    expect(parseMobileMoneySmsBatch("Vous avez reçu 5 000 FCFA de A. Ref: R1").unparsed).toHaveLength(1);
  });
});
