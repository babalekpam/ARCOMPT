// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { AiGateway, MemoryCallLogger, MockProvider } from "@arcompt/ai-gateway";
import { AiLlmMatcher } from "./llm-matcher.js";

const req = {
  transaction: { id: "t1", date: "2025-03-12", label: "REMISE CHQ 12345", amount: "250000.0000", reference: null },
  candidates: [
    { lineId: "l1", date: "2025-03-12", label: "Remise chèque 12345", amount: "250000.0000", reference: null },
    { lineId: "l2", date: "2025-03-12", label: "Remise chèque 12346", amount: "250000.0000", reference: null },
  ],
};

describe("AiLlmMatcher", () => {
  it("passe par la passerelle (capacité reconcile), valide le schéma et journalise", async () => {
    const provider = new MockProvider(['{"candidate_line_id":"l1","confidence":0.96,"rationale":"numéro de chèque identique"}']);
    const logger = new MemoryCallLogger();
    const matcher = new AiLlmMatcher(new AiGateway({ provider, logger }));
    const result = await matcher.match({ tenantId: "T", userId: "U" }, req);
    expect(result).toEqual({ lineId: "l1", confidence: 0.96, rationale: "numéro de chèque identique" });
    expect(provider.calls[0]!.capability).toBe("reconcile");
    expect(logger.entries[0]).toMatchObject({ tenantId: "T", capability: "reconcile", schemaValid: true, confidence: 0.96 });
  });

  it("ignore un identifiant inventé par le modèle", async () => {
    const matcher = new AiLlmMatcher(new AiGateway({ provider: new MockProvider(['{"candidate_line_id":"l999","confidence":0.99,"rationale":"?"}']), logger: new MemoryCallLogger() }));
    expect(await matcher.match({ tenantId: "T" }, req)).toMatchObject({ lineId: null, confidence: 0 });
  });

  it("rejette une sortie non conforme au schéma", async () => {
    const matcher = new AiLlmMatcher(new AiGateway({ provider: new MockProvider(["pas du json"]), logger: new MemoryCallLogger() }));
    await expect(matcher.match({ tenantId: "T" }, req)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
});
