// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import type { ProposalRecord } from "@arcompt/documents";
import { WhatsAppBot, ONBOARDING_TEXT, VERIFY_TEXT, type BotDocuments } from "./bot.js";
import { MemoryConversationStore } from "./conversation.js";
import { MockProvider, type InboundMessage } from "./provider.js";

const PHONE = "2250707070707";
const NOW = new Date("2025-03-06T10:00:00Z");

/** Service de pièces simulé : enregistre les appels, renvoie des propositions plausibles. */
class FakeDocuments implements BotDocuments {
  readonly calls: string[] = [];
  private seq = 0;
  private proposals = new Map<string, ProposalRecord>();

  private make(over: Partial<ProposalRecord>): ProposalRecord {
    const id = `p${++this.seq}`;
    const p: ProposalRecord = {
      id,
      tenantId: "t",
      documentId: null,
      source: "WHATSAPP",
      kind: "ENTRY",
      extraction: null,
      proposal: { journal_code: "CA", date: "2025-03-05", label: "Dépense", lines: [], confidence: 0.9, rationale: "", alternatives: [] },
      confidence: 0.9,
      guardIssues: [],
      route: "ONE_TAP_VALIDATION",
      status: "PENDING",
      decidedBy: null,
      decidedAt: null,
      entryId: null,
      correction: null,
      createdAt: NOW.toISOString(),
      ...over,
    };
    this.proposals.set(id, p);
    return p;
  }

  async upload(input: { bytes: Uint8Array }) {
    this.calls.push(`upload:${input.bytes.length}`);
    return { document: { id: "doc1", filename: "facture.jpg" } as never, duplicate: input.bytes.length === 3 };
  }
  async extract(id: string) {
    this.calls.push(`extract:${id}`);
    return { document: {} as never, extraction: null, issues: [], needsOcr: false };
  }
  async propose(id: string) {
    this.calls.push(`propose:${id}`);
    return this.make({
      documentId: id,
      extraction: { document_type: "INVOICE", supplier_name: "CIE", supplier_tax_id: null, customer_name: null, reference: "F-77", date: "2025-03-05", currency: "XOF", amount_excl_tax: "100000", vat_amount: "18000", amount_incl_tax: "118000", lines: [], confidence: 0.93, notes: null },
      proposal: { journal_code: "AC", date: "2025-03-05", label: "Facture CIE F-77", lines: [{ account_number: "6052", debit: "100000", account_label: "Fournitures non stockables – électricité" }, { account_number: "445", debit: "18000" }, { account_number: "401", credit: "118000", partner_id: "pp" }], confidence: 0.93, rationale: "", alternatives: [] },
    });
  }
  async proposeCashExpense(input: { amount: string; label: string; means: string }) {
    this.calls.push(`cash:${input.amount}:${input.label}:${input.means}`);
    return this.make({ proposal: { journal_code: "CA", date: "2025-03-06", label: input.label, lines: [{ account_number: "6053", debit: input.amount, account_label: "Fournitures non stockables – autres énergies" }, { account_number: "571", credit: input.amount }], confidence: 0.8, rationale: "", alternatives: [] }, confidence: 0.8, route: "REVIEW_QUEUE", guardIssues: [{ code: "LOW_CONFIDENCE", message: "Confiance 0.8 < 0.85" }] });
  }
  async validate(id: string) {
    this.calls.push(`validate:${id}`);
    return { proposal: this.proposals.get(id)!, entry: { id: "e1", number: 7, journalCode: "AC", date: "2025-03-05" } as never };
  }
  async correct(id: string, lines: Array<{ account_number: string }>) {
    this.calls.push(`correct:${id}:${lines.map((l) => l.account_number).join(",")}`);
    return { proposal: this.proposals.get(id)!, entry: { id: "e2", number: 8, journalCode: "CA", date: "2025-03-06" } as never };
  }
  async reject(id: string) {
    this.calls.push(`reject:${id}`);
    return this.proposals.get(id)!;
  }
  async getProposal(id: string) {
    return this.proposals.get(id)!;
  }
}

function setup(verifiedAt: string | null = NOW.toISOString()) {
  const provider = new MockProvider();
  const store = new MemoryConversationStore();
  store.link(PHONE, { tenantId: "t", userId: "u", conversationId: "c1", phone: PHONE, verifiedAt });
  const docs = new FakeDocuments();
  const bot = new WhatsAppBot({ provider, store, documentsFor: () => docs, now: () => NOW });
  return { provider, store, docs, bot };
}

let seq = 0;
const msg = (over: Partial<InboundMessage>): InboundMessage => ({ id: `m${++seq}`, from: PHONE, timestamp: Math.floor(NOW.getTime() / 1000) - 5, type: "TEXT", ...over });

describe("bot WhatsApp", () => {
  it("répond les instructions d'inscription à un numéro inconnu", async () => {
    const { provider, bot } = setup();
    await bot.handle(msg({ from: "33600000000", text: "bonjour" }));
    expect(provider.last()).toEqual({ to: "33600000000", text: ONBOARDING_TEXT });
  });

  it("photo → pièce → proposition résumée en français avec boutons, puis validation", async () => {
    const { provider, store, docs, bot } = setup();
    provider.media.set("media-1", { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/jpeg" });
    await bot.handle(msg({ type: "IMAGE", mediaId: "media-1", mimeType: "image/jpeg" }));
    expect(docs.calls).toEqual(["upload:4", "extract:doc1", "propose:doc1"]);
    const last = provider.last()!;
    expect(last.text).toBe("Facture CIE 118 000 FCFA du 05/03 → 6052 Fournitures non stockables – électricité. Valider ?");
    expect(last.buttons?.map((b) => b.title)).toEqual(["VALIDER", "CORRIGER", "REJETER"]);
    expect(store.states.get("c1")?.pendingProposalId).toBe("p1");

    await bot.handle(msg({ type: "INTERACTIVE", buttonId: "validate:p1", buttonTitle: "VALIDER" }));
    expect(docs.calls.at(-1)).toBe("validate:p1");
    expect(provider.last()?.text).toContain("Écriture AC n°7 comptabilisée");
    expect(store.states.get("c1")?.pendingProposalId).toBeUndefined();
    expect(store.messages.filter((m) => m.direction === "IN")).toHaveLength(2);
    expect(store.messages.filter((m) => m.direction === "OUT" && m.proposalId === "p1")).toHaveLength(2);
  });

  it("refuse la validation sans session authentifiée récente", async () => {
    const { provider, docs, bot } = setup(new Date(NOW.getTime() - 25 * 3600 * 1000).toISOString());
    await bot.handle(msg({ text: "j'ai payé 50 000 de carburant en espèces" }));
    expect(docs.calls).toEqual(["cash:50000:carburant:CASH"]);
    expect(provider.last()?.text).toContain("Dépense carburant 50 000 FCFA du 06/03 → 6053");
    expect(provider.last()?.text).toContain("Confiance 80 %");
    await bot.handle(msg({ type: "INTERACTIVE", buttonId: "validate:p1" }));
    expect(provider.last()?.text).toBe(VERIFY_TEXT);
    expect(docs.calls).toHaveLength(1);
  });

  it("CORRIGER demande le compte puis comptabilise la correction", async () => {
    const { provider, docs, bot } = setup();
    await bot.handle(msg({ text: "payé 20000 de carburant cash" }));
    await bot.handle(msg({ type: "INTERACTIVE", buttonId: "correct:p1" }));
    expect(provider.last()?.text).toContain("Quel compte");
    await bot.handle(msg({ text: "n'importe quoi" }));
    expect(provider.last()?.text).toContain("numéro de compte");
    await bot.handle(msg({ text: "6054" }));
    expect(docs.calls.at(-1)).toBe("correct:p1:6054,571");
    expect(provider.last()?.text).toContain("Corrigé : compte 6054");
  });

  it("ignore les rejeux et les messages trop anciens ; pièce en doublon signalée", async () => {
    const { provider, docs, bot } = setup();
    const m = msg({ text: "payé 1000 de café en espèces" });
    await bot.handle(m);
    await bot.handle(m);
    expect(docs.calls).toHaveLength(1);
    await bot.handle(msg({ text: "payé 1000 de café en espèces", timestamp: Math.floor(NOW.getTime() / 1000) - 3600 }));
    expect(docs.calls).toHaveLength(1);
    provider.media.set("dup", { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    await bot.handle(msg({ type: "IMAGE", mediaId: "dup" }));
    expect(provider.last()?.text).toContain("déjà été reçue");
    await bot.handle(msg({ text: "???" }));
    expect(provider.last()?.text).toContain("Je n'ai pas compris");
  });
});
