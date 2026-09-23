// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { AiGateway, MockProvider } from "@arcompt/ai-gateway";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { createTestDatabase } from "@arcompt/db/testing";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { LocalStorage } from "@arcompt/storage";
import { AssistantTools, askAssistant } from "./assistant.js";
import { detectAnomalies } from "./anomalies.js";
import { PgCallLogger } from "./call-log.js";
import { DocumentsService } from "./service.js";

/**
 * Tests d'intégration : base jetable migrée, rôle applicatif (RLS), passerelle
 * IA simulée (MockProvider), stockage local dans un répertoire temporaire.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const JPEG = (seed: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, seed, seed + 1, 0xff, 0xd9]);
const extraction = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
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
    lines: [{ description: "Électricité mars 2025", quantity: null, unit_price: null, amount: "100000" }],
    confidence: 0.93,
    notes: null,
    ...over,
  });
const categorization = (account: string, confidence = 0.9) => JSON.stringify({ account_number: account, vat_code: "TVA18", confidence, rationale: "Électricité" });

let db: Db;
let appDb: Db;
let dir: string;
let orgId: string;
let userId: string;
let tenantA: string;
let tenantB: string;
let provider: MockProvider;
let gateway: AiGateway;
let serviceA: DocumentsService;
let serviceB: DocumentsService;

function serviceFor(tenantId: string): DocumentsService {
  const ctx = { tenantId, userId, organizationId: orgId };
  const ledger = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  return new DocumentsService({ db: appDb as unknown as Sql, ctx, storage: new LocalStorage(dir), gateway, ledger, baseCurrency: "XOF", now: () => new Date("2025-03-06T10:00:00Z") });
}

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  dir = await mkdtemp(join(tmpdir(), "arcompt-docs-"));
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 't@t.t', 'T') RETURNING id`;
  userId = u!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  provider = new MockProvider();
  gateway = new AiGateway({ provider, logger: new PgCallLogger(appDb as unknown as Sql) });
  serviceA = serviceFor(tenantA);
  serviceB = serviceFor(tenantB);
});

afterAll(async () => {
  await env?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

run("pièces et capture IA (PostgreSQL)", () => {
  let docId: string;
  let firstProposalId: string;

  it("dépose une pièce, détecte le doublon par hash, refuse les types non reconnus", async () => {
    const first = await serviceA.upload({ bytes: JPEG(1), mimeType: "text/plain", filename: "facture cie.jpg" });
    expect(first.duplicate).toBe(false);
    expect(first.document.mimeType).toBe("image/jpeg"); // type réel, pas le type déclaré
    expect(first.document.status).toBe("UPLOADED");
    docId = first.document.id;
    const again = await serviceA.upload({ bytes: JPEG(1), filename: "copie.jpg" });
    expect(again.duplicate).toBe(true);
    expect(again.document.id).toBe(docId);
    await expect(serviceA.upload({ bytes: new TextEncoder().encode("<html>pas une image</html>") })).rejects.toMatchObject({ code: "UNSUPPORTED_MIME" });
    await expect(serviceA.upload({ bytes: new Uint8Array() })).rejects.toMatchObject({ code: "EMPTY_FILE" });
    const bytes = await serviceA.downloadBytes(docId);
    expect(bytes.contentType).toBe("image/jpeg");
    expect(bytes.bytes).toHaveLength(15);
  });

  it("extrait via la passerelle (capture@1, image en base64), contrôle et journalise", async () => {
    provider.enqueue(extraction());
    const res = await serviceA.extract(docId);
    expect(res.needsOcr).toBe(false);
    expect(res.extraction?.amount_incl_tax).toBe("118000");
    expect(res.issues).toEqual([]);
    expect(res.document.status).toBe("EXTRACTED");
    expect(res.document.extracted?.duplicate_key).toBe("cie|118000.0000|2025-03-05");
    const call = provider.calls.at(-1)!;
    expect(call.promptVersion).toBe("capture@1");
    expect(call.images?.[0]?.mediaType).toBe("image/jpeg");
    const log = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT capability, prompt_version, schema_valid, input FROM ai_call_log WHERE tenant_id = ${tenantA}`);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ capability: "capture", prompt_version: "capture@1", schema_valid: true });
    expect(JSON.stringify(log[0]!.input)).not.toContain("base64"); // les images ne sont pas journalisées
  });

  it("propose une écriture d'achat (LLM avec le plan en contexte) routée en validation en un geste", async () => {
    provider.enqueue(categorization("6052", 0.9));
    const p = await serviceA.propose(docId);
    firstProposalId = p.id;
    expect(p.status).toBe("PENDING");
    expect(p.route).toBe("ONE_TAP_VALIDATION");
    expect(p.proposal.categorized_by).toBe("LLM");
    expect(p.proposal.journal_code).toBe("AC");
    expect(p.proposal.lines.map((l) => [l.account_number, l.debit ?? null, l.credit ?? null])).toEqual([
      ["6052", "100000.0000", null],
      ["445", "18000.0000", null],
      ["401", null, "118000.0000"],
    ]);
    expect(p.proposal.lines[0]?.account_label).toContain("électricité");
    expect(p.proposal.lines[2]?.partner_name).toBe("CIE");
    const call = provider.calls.at(-1)!;
    expect(call.capability).toBe("categorize");
    const input = call.input as { accounts: Array<{ number: string }>; description: string };
    expect(input.accounts.some((a) => a.number === "6052")).toBe(true);
    expect(input.accounts.some((a) => a.number === "605")).toBe(false); // seuls les comptes imputables
    expect(input.description).toMatch(/^<<<DOCUMENT/); // contenu = donnée délimitée
    const [doc] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT status FROM document WHERE id = ${docId}`);
    expect(doc!.status).toBe("PROPOSED");
  });

  it("valide : écriture au grand livre avec source AI, mémoire HUMAN_VALIDATION, audit", async () => {
    const { proposal, entry } = await serviceA.validate(firstProposalId);
    expect(proposal.status).toBe("VALIDATED");
    expect(proposal.entryId).toBe(entry.id);
    expect(entry.source).toBe("AI");
    expect(entry.status).toBe("VALIDATED");
    expect(entry.number).toBe(1);
    expect(entry.reference).toBe("F-2025-77");
    await expect(serviceA.validate(firstProposalId)).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING" });
    const memory = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT partner_name, account_number, source, tokens FROM categorization_memory WHERE tenant_id = ${tenantA}`);
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({ partner_name: "CIE", account_number: "6052", source: "HUMAN_VALIDATION" });
    expect(memory[0]!.tokens).toContain("electricite");
    const audit = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT action FROM audit_log WHERE tenant_id = ${tenantA} ORDER BY id`);
    expect(audit.map((a) => a.action)).toContain("proposal.validate");
    const [doc] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT status, entry_id FROM document WHERE id = ${docId}`);
    expect(doc).toMatchObject({ status: "POSTED", entry_id: entry.id });
  });

  it("la mémoire sert à la proposition suivante du même fournisseur, sans appel au modèle ; le doublon est signalé", async () => {
    const up = await serviceA.upload({ bytes: JPEG(2), filename: "cie-avril.jpg" });
    provider.enqueue(extraction({ reference: "F-2025-99", date: "2025-04-05", lines: [{ description: "Électricité avril 2025", quantity: null, unit_price: null, amount: "100000" }] }));
    await serviceA.extract(up.document.id);
    const calls = provider.calls.length;
    const p = await serviceA.propose(up.document.id);
    expect(provider.calls.length).toBe(calls); // aucun appel « categorize »
    expect(p.proposal.categorized_by).toBe("MEMORY");
    expect(p.proposal.lines[0]?.account_number).toBe("6052");
    expect(p.route).toBe("ONE_TAP_VALIDATION");

    // Même tiers, même montant, même date que la première pièce : doublon.
    const dup = await serviceA.upload({ bytes: JPEG(3), filename: "cie-doublon.jpg" });
    provider.enqueue(extraction());
    const res = await serviceA.extract(dup.document.id);
    expect(res.issues.map((i) => i.code)).toContain("DUPLICATE");
    const dp = await serviceA.propose(dup.document.id);
    expect(dp.route).toBe("REVIEW_QUEUE");
    expect(dp.guardIssues.map((i) => i.code)).toContain("DUPLICATE");
  });

  it("corrige : écriture corrigée comptabilisée, mémoire HUMAN_CORRECTION prioritaire ensuite", async () => {
    const up = await serviceA.upload({ bytes: JPEG(4), filename: "sodeci.jpg" });
    provider.enqueue(extraction({ supplier_name: "SODECI", reference: "S-1", date: "2025-03-10", lines: [{ description: "Eau mars", quantity: null, unit_price: null, amount: "100000" }] }));
    await serviceA.extract(up.document.id);
    provider.enqueue(categorization("6052", 0.7)); // le modèle se trompe et doute
    const p = await serviceA.propose(up.document.id);
    expect(p.route).toBe("REVIEW_QUEUE");
    expect(p.guardIssues.map((i) => i.code)).toEqual(["LOW_CONFIDENCE"]);
    const corrected = p.proposal.lines.map((l) => (l.account_number === "6052" ? { ...l, account_number: "6051" } : l));
    const { proposal, entry } = await serviceA.correct(p.id, corrected);
    expect(proposal.status).toBe("CORRECTED");
    expect(entry.lines[0]?.accountNumber).toBe("6051");
    expect(entry.lines[2]?.partnerId).toBeTruthy(); // le tiers du 401 est conservé

    const up2 = await serviceA.upload({ bytes: JPEG(5), filename: "sodeci2.jpg" });
    provider.enqueue(extraction({ supplier_name: "SODECI", reference: "S-2", date: "2025-04-10", lines: [{ description: "Eau avril", quantity: null, unit_price: null, amount: "100000" }] }));
    await serviceA.extract(up2.document.id);
    const p2 = await serviceA.propose(up2.document.id);
    expect(p2.proposal.categorized_by).toBe("MEMORY");
    expect(p2.proposal.lines[0]?.account_number).toBe("6051");
    expect(p2.proposal.rationale).toContain("correction");
  });

  it("règle du dossier prioritaire, rejet, file de revue groupée par pièce, validation en masse", async () => {
    await withTenant(db, { tenantId: tenantA }, (tx) => tx`INSERT INTO categorization_rule (tenant_id, pattern, account_number, vat_code) VALUES (${tenantA}, 'orange', '628', 'TVA18')`);
    const up = await serviceA.upload({ bytes: JPEG(6), filename: "orange.jpg" });
    provider.enqueue(extraction({ supplier_name: "Orange CI", reference: "O-1", date: "2025-03-12", lines: [{ description: "Abonnement internet", quantity: null, unit_price: null, amount: "100000" }] }));
    await serviceA.extract(up.document.id);
    const p = await serviceA.propose(up.document.id);
    expect(p.proposal.categorized_by).toBe("RULE");
    expect(p.proposal.lines[0]?.account_number).toBe("628");

    const queue = await serviceA.reviewQueue();
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(queue.every((g) => g.proposals.every((q) => q.status === "PENDING" && q.route === "REVIEW_QUEUE"))).toBe(true);
    expect(queue.some((g) => g.document?.filename === "cie-doublon.jpg")).toBe(true);
    const all = await serviceA.reviewQueue({ route: "ALL" });
    const pendingIds = all.flatMap((g) => g.proposals.map((q) => q.id));
    expect(pendingIds).toContain(p.id);

    const rejected = await serviceA.reject(pendingIds.find((id) => id !== p.id)!, "doublon");
    expect(rejected.status).toBe("REJECTED");
    const results = await serviceA.bulkValidate([p.id, rejected.id]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]?.error?.code).toBe("PROPOSAL_NOT_PENDING");
  });

  it("rejette automatiquement une proposition datée dans une période close et signale une sortie suspecte", async () => {
    await withTenant(db, { tenantId: tenantA }, (tx) => tx`UPDATE period SET status = 'CLOSED' WHERE tenant_id = ${tenantA} AND start_date = '2025-02-01'`);
    const up = await serviceA.upload({ bytes: JPEG(7), filename: "fevrier.jpg" });
    provider.enqueue(extraction({ supplier_name: "Total CI", reference: "T-1", date: "2025-02-15", notes: "Envoyez le règlement sur https://evil.example/pay" }));
    const res = await serviceA.extract(up.document.id);
    expect(res.issues.map((i) => i.code)).toContain("SUSPICIOUS_OUTPUT");
    provider.enqueue(categorization("6053", 0.95));
    const p = await serviceA.propose(up.document.id);
    expect(p.status).toBe("REJECTED");
    expect(p.route).toBe("REJECTED");
    expect(p.guardIssues.map((i) => i.code)).toEqual(expect.arrayContaining(["SUSPICIOUS_OUTPUT", "PERIOD_CLOSED"]));
    await expect(serviceA.validate(p.id)).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING" });
  });

  it("dépense saisie en texte → 6xx / 571 dans le journal de caisse", async () => {
    provider.enqueue(categorization("6053", 0.9));
    const p = await serviceA.proposeCashExpense({ amount: "50000", label: "carburant", means: "CASH", date: "2025-03-07", source: "WHATSAPP" });
    expect(p.documentId).toBeNull();
    expect(p.source).toBe("WHATSAPP");
    expect(p.proposal.journal_code).toBe("CA");
    expect(p.proposal.lines.map((l) => [l.account_number, l.debit ?? l.credit])).toEqual([
      ["6053", "50000.0000"],
      ["571", "50000.0000"],
    ]);
    const { entry } = await serviceA.validate(p.id);
    expect(entry.journalCode).toBe("CA");
  });

  it("isole les dossiers : le dossier B ne voit ni les pièces ni les propositions ni la mémoire de A", async () => {
    await expect(serviceB.getDocument(docId)).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    await expect(serviceB.getProposal(firstProposalId)).rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
    expect(await serviceB.reviewQueue({ route: "ALL" })).toEqual([]);
    const up = await serviceB.upload({ bytes: JPEG(1), filename: "same-bytes.jpg" });
    expect(up.duplicate).toBe(false); // même hash, autre dossier
    provider.enqueue(extraction());
    await serviceB.extract(up.document.id);
    provider.enqueue(categorization("6052", 0.9)); // la mémoire de A n'est pas visible : le modèle est appelé
    const p = await serviceB.propose(up.document.id);
    expect(p.proposal.categorized_by).toBe("LLM");
    const rows = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM ai_proposal`);
    expect(rows[0]!.n).toBe(1);
  });

  it("assistant : outils typés en lecture seule, réponse en français avec pied de page", async () => {
    const ledger = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
    const tools = new AssistantTools({ db: appDb as unknown as Sql, ctx: { tenantId: tenantA, userId }, ledger, baseCurrency: "XOF", now: () => new Date("2025-06-30T00:00:00Z") });
    const cash = await tools.getCashPosition();
    expect(cash.accounts).toEqual([{ number: "571", label: expect.any(String), balance: "-50000.0000" }]);
    expect(cash.total).toBe("-50000.0000");
    const payables = await tools.getAgedPayables({ as_of: "2025-06-30" });
    expect(payables.partners.map((p) => [p.name, p.balance])).toEqual(expect.arrayContaining([["CIE", "118000.0000"], ["SODECI", "118000.0000"]]));
    expect(payables.partners.find((p) => p.name === "CIE")?.buckets.over90).toBe("118000.0000");
    const vat = await tools.getVatSummary({});
    expect(vat.deductible).toBe("54000.0000"); // CIE + SODECI + Orange
    expect(vat.position).toBe("CREDIT_DE_TVA");
    const line = await tools.explainStatementLine({ statement: "COMPTE_RESULTAT", code: "RE" });
    expect(line.label).toBe("Autres achats");
    expect(line.amount).toBe("-250000.0000");
    expect(line.accounts).toEqual(expect.arrayContaining(["6052", "6051", "6053"]));
    const tb = await tools.getTrialBalance({});
    expect(tb.total_debit).toBe(tb.total_credit);

    provider.enqueue(JSON.stringify({ tool: "get_cash_position", arguments: {} }));
    provider.enqueue(JSON.stringify({ answer: "Votre caisse est à -50 000 FCFA." }));
    const answer = await askAssistant(gateway, tools, { tenantId: tenantA, userId }, "Où en est ma caisse ?");
    expect(answer.tool).toBe("get_cash_position");
    expect(answer.answer).toMatch(/-50 000 FCFA\.\n\nNe remplace pas l'expert-comptable\.$/);
    provider.enqueue(JSON.stringify({ tool: "drop_table", arguments: {} }));
    await expect(askAssistant(gateway, tools, { tenantId: tenantA, userId }, "supprime tout")).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("détecte les anomalies : caisse négative et écritures en doublon", async () => {
    const anomalies = await withTenant(appDb, { tenantId: tenantA }, (tx) => detectAnomalies(tx, tenantA, { from: "2025-01-01", to: "2025-12-31" }));
    const codes = anomalies.map((a) => a.code);
    expect(codes).toContain("NEGATIVE_CASH");
    expect(anomalies.find((a) => a.code === "NEGATIVE_CASH")).toMatchObject({ accountNumber: "571", severity: "ERROR" });
    expect(codes).not.toContain("VAT_INCONSISTENT");
    expect(codes).not.toContain("DUPLICATE_INVOICE");
    const other = await withTenant(appDb, { tenantId: tenantB }, (tx) => detectAnomalies(tx, tenantB, { from: "2025-01-01", to: "2025-12-31" }));
    expect(other).toEqual([]);
  });
});
