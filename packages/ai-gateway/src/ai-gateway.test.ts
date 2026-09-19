import { describe, expect, it } from "vitest";
import { AiGateway, AiGatewayError, MemoryCallLogger, MockProvider } from "./gateway.js";
import { checkExtractionArithmetic, checkProposal, duplicateKey, routeProposal } from "./guards.js";
import { DocumentExtractionSchema, EntryProposalSchema } from "./schemas.js";

const extraction = {
  document_type: "INVOICE",
  supplier_name: "CIE",
  supplier_tax_id: "1234567A",
  customer_name: null,
  reference: "F-2025-77",
  date: "2025-03-05",
  currency: "XOF",
  amount_excl_tax: "100000",
  vat_amount: "18000",
  amount_incl_tax: "118000",
  lines: [],
  confidence: 0.93,
  notes: null,
};

describe("passerelle IA", () => {
  it("valide la sortie JSON par schéma et journalise l'appel", async () => {
    const provider = new MockProvider(["```json\n" + JSON.stringify(extraction) + "\n```"]);
    const logger = new MemoryCallLogger();
    const gw = new AiGateway({ provider, logger, now: () => new Date("2025-03-05T10:00:00Z") });
    const { data } = await gw.callJson({ tenantId: "t1", userId: "u1" }, { capability: "capture", promptVersion: "capture@1", system: "…", input: { hint: "facture" } }, DocumentExtractionSchema);
    expect(data.amount_incl_tax).toBe("118000");
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ tenantId: "t1", capability: "capture", promptVersion: "capture@1", schemaValid: true, confidence: 0.93, model: "mock" });
  });

  it("rejette une sortie non conforme mais la journalise quand même", async () => {
    const provider = new MockProvider([JSON.stringify({ ...extraction, amount_incl_tax: 118000 }), "pas du json"]);
    const logger = new MemoryCallLogger();
    const gw = new AiGateway({ provider, logger });
    const req = { capability: "capture" as const, promptVersion: "capture@1", system: "…", input: {} };
    await expect(gw.callJson({ tenantId: "t1" }, req, DocumentExtractionSchema)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    await expect(gw.callJson({ tenantId: "t1" }, req, DocumentExtractionSchema)).rejects.toBeInstanceOf(AiGatewayError);
    expect(logger.entries.map((e) => e.schemaValid)).toEqual([false, false]);
  });

  it("applique les quotas par dossier", async () => {
    const gw = new AiGateway({ provider: new MockProvider(), logger: new MemoryCallLogger(), quota: { allow: async () => false } });
    await expect(gw.callJson({ tenantId: "t1" }, { capability: "assistant", promptVersion: "a@1", system: "", input: "" }, DocumentExtractionSchema)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});

describe("garde-fous", () => {
  it("contrôle HT + TVA = TTC", () => {
    expect(checkExtractionArithmetic(extraction as never)).toEqual([]);
    expect(checkExtractionArithmetic({ ...extraction, vat_amount: "17000" } as never)[0]?.code).toBe("HT_TVA_TTC");
    expect(checkExtractionArithmetic({ ...extraction, amount_incl_tax: null } as never)[0]?.code).toBe("MISSING_AMOUNT");
  });

  it("rejette un compte hors plan, un déséquilibre ; route la faible confiance vers la revue", () => {
    const chart = (n: string) => (n === "605" || n === "445" || n === "401" ? { postable: true } : n === "60" ? { postable: false } : null);
    const proposal = EntryProposalSchema.parse({
      journal_code: "AC",
      date: "2025-03-05",
      label: "Facture CIE",
      lines: [{ account_number: "605", debit: "100000" }, { account_number: "445", debit: "18000" }, { account_number: "401", credit: "118000" }],
      confidence: 0.9,
      rationale: "Électricité",
    });
    expect(checkProposal(proposal, chart)).toEqual([]);
    expect(routeProposal(checkProposal(proposal, chart))).toBe("ONE_TAP_VALIDATION");
    expect(routeProposal(checkProposal({ ...proposal, confidence: 0.5 }, chart))).toBe("REVIEW_QUEUE");
    expect(routeProposal(checkProposal({ ...proposal, lines: [{ account_number: "999", debit: "118000" }, { account_number: "401", credit: "118000" }] }, chart))).toBe("REJECTED");
    expect(routeProposal(checkProposal({ ...proposal, lines: [{ account_number: "60", debit: "118000" }, { account_number: "401", credit: "118000" }] }, chart))).toBe("REVIEW_QUEUE");
    expect(checkProposal({ ...proposal, lines: [{ account_number: "605", debit: "1" }, { account_number: "401", credit: "2" }] }, chart).map((i) => i.code)).toEqual(["UNBALANCED"]);
  });

  it("calcule une clé de doublon normalisée", () => {
    expect(duplicateKey({ supplier_name: "  CIE ", amount_incl_tax: "118000", date: "2025-03-05" })).toBe("cie|118000.0000|2025-03-05");
    expect(duplicateKey({ supplier_name: "CIE", amount_incl_tax: null, date: "2025-03-05" })).toBeNull();
  });
});
