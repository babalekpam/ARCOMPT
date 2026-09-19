import { describe, expect, it } from "vitest";
import { buildImportRequest, detectImportKind } from "./import-text";

describe("detectImportKind", () => {
  it("reconnaît un CSV régulier (point-virgule, virgule ou tabulation)", () => {
    expect(detectImportKind("date;libellé;montant\n01/06/2025;Virement;1000\n02/06/2025;Retrait;-500")).toBe("CSV");
    expect(detectImportKind("date,label,amount\n2025-06-01,Virement,1000")).toBe("CSV");
    expect(detectImportKind("date\tlabel\tamount\n2025-06-01\tVirement\t1000")).toBe("CSV");
  });

  it("reconnaît un lot de SMS mobile money", () => {
    expect(detectImportKind("Vous avez recu 15000 FCFA de 0700000000. Ref 12345.\nTransfert de 2000 XOF vers Wave effectue.")).toBe("SMS");
    expect(detectImportKind("MTN MoMo: depot de 5000 XAF")).toBe("SMS");
  });

  it("se replie sur CSV pour un texte vide ou neutre", () => {
    expect(detectImportKind("")).toBe("CSV");
    expect(detectImportKind("bonjour")).toBe("CSV");
  });
});

describe("buildImportRequest", () => {
  it("envoie un CSV brut en text/csv avec la période en requête", () => {
    const r = buildImportRequest("acc-1", { kind: "CSV", text: "a;b;c", periodFrom: "2025-06-01", periodTo: "", openingBalance: " 100 " });
    expect(r.path).toBe("/treasury/accounts/acc-1/statements");
    expect(r.contentType).toBe("text/csv");
    expect(r.body).toBe("a;b;c");
    expect(r.query).toEqual({ periodFrom: "2025-06-01", periodTo: undefined, openingBalance: "100", closingBalance: undefined, source: "CSV" });
  });

  it("passe en JSON dès qu'une option de parseur CSV est fournie", () => {
    const r = buildImportRequest("acc-1", { kind: "CSV", text: "a;b", dateFormat: "DMY", bankPerspective: true, hasHeader: false, periodFrom: "2025-06-01" });
    expect(r.contentType).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({ periodFrom: "2025-06-01", csv: "a;b", csvOptions: { dateFormat: "DMY", hasHeader: false, bankPerspective: true }, source: "CSV" });
    expect(r.query).toEqual({});
  });

  it("envoie les SMS en JSON avec leurs options", () => {
    const r = buildImportRequest("acc-2", { kind: "SMS", text: "Vous avez recu 1000 FCFA", defaultDate: "2025-06-15", includeFees: false });
    expect(r.contentType).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({ sms: "Vous avez recu 1000 FCFA", source: "SMS", smsOptions: { defaultDate: "2025-06-15", includeFees: false } });
    const plain = buildImportRequest("acc-2", { kind: "SMS", text: "x" });
    expect(JSON.parse(plain.body)).toEqual({ sms: "x", source: "SMS" });
  });
});
