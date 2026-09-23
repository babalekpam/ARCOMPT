// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { AiGateway, MemoryCallLogger, MockProvider as MockModelProvider } from "@arcompt/ai-gateway";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { createTestDatabase } from "@arcompt/db/testing";
import { DocumentsService } from "@arcompt/documents";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { LocalStorage } from "@arcompt/storage";
import { WhatsAppBot, ONBOARDING_TEXT, VERIFY_TEXT } from "./bot.js";
import { linkPhone, markPhoneVerified, PgConversationStore } from "./conversation.js";
import { MockProvider, type InboundMessage } from "./provider.js";

/** Intégration : résolution du numéro sans contexte tenant (rôle applicatif), dialogue complet avec le service de pièces réel. */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const PHONE = "2250707070707";
const NOW = new Date("2025-03-06T10:00:00Z");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0xff, 0xd9]);

let db: Db;
let appDb: Db;
let dir: string;
let orgId: string;
let userId: string;
let tenantId: string;
let model: MockModelProvider;
let provider: MockProvider;
let store: PgConversationStore;
let bot: WhatsAppBot;
let seq = 0;
const msg = (over: Partial<InboundMessage>): InboundMessage => ({ id: `wamid.${++seq}`, from: PHONE, timestamp: Math.floor(NOW.getTime() / 1000) - 5, type: "TEXT", ...over });

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  dir = await mkdtemp(join(tmpdir(), "arcompt-wa-"));
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'w@t.t', 'W') RETURNING id`;
  userId = u!.id as string;
  tenantId = (await seedCompany(db, { organizationId: orgId, name: "WA", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" } })).companyId;
  model = new MockModelProvider();
  const gateway = new AiGateway({ provider: model, logger: new MemoryCallLogger() });
  provider = new MockProvider();
  store = new PgConversationStore(appDb as unknown as Sql);
  bot = new WhatsAppBot({
    provider,
    store,
    gateway,
    now: () => NOW,
    documentsFor: (ctx) =>
      new DocumentsService({
        db: appDb as unknown as Sql,
        ctx,
        storage: new LocalStorage(dir),
        gateway,
        ledger: new Ledger(new PostgresStore(appDb as unknown as Sql, { userId: ctx.userId }), { baseCurrency: "XOF" }),
        baseCurrency: "XOF",
        now: () => NOW,
      }),
  });
});

afterAll(async () => {
  await env?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

run("WhatsApp (PostgreSQL)", () => {
  it("numéro inconnu → instructions ; numéro lié → résolu par la fonction SECURITY DEFINER avec le rôle applicatif", async () => {
    expect(await store.resolvePhone(PHONE)).toBeNull();
    await bot.handle(msg({ text: "bonjour" }));
    expect(provider.last()?.text).toBe(ONBOARDING_TEXT);

    await linkPhone(appDb as unknown as Sql, { tenantId, userId, organizationId: orgId }, "+225 07 07 07 07 07");
    const resolved = await store.resolvePhone(PHONE);
    expect(resolved).toMatchObject({ tenantId, userId, verifiedAt: null });
    // Sans contexte tenant, la table reste invisible : seule la fonction expose les identifiants.
    expect(await appDb`SELECT count(*)::int AS n FROM whatsapp_conversation`).toEqual([{ n: 0 }]);
  });

  it("texte → proposition ; validation refusée tant que la session n'est pas vérifiée, puis comptabilisée", async () => {
    model.enqueue(JSON.stringify({ account_number: "6053", vat_code: null, confidence: 0.9, rationale: "Carburant" }));
    await bot.handle(msg({ text: "j'ai payé 50 000 de carburant en espèces" }));
    expect(provider.last()?.text).toBe("Dépense carburant 50 000 FCFA du 06/03 → 6053 Fournitures non stockables – autres énergies. Valider ?");
    const proposalId = provider.last()!.buttons![0]!.id.split(":")[1]!;

    await bot.handle(msg({ type: "INTERACTIVE", buttonId: `validate:${proposalId}` }));
    expect(provider.last()?.text).toBe(VERIFY_TEXT);

    expect(await markPhoneVerified(appDb as unknown as Sql, { tenantId, userId }, PHONE)).toBe(true);
    await bot.handle(msg({ type: "INTERACTIVE", buttonId: `validate:${proposalId}` }));
    expect(provider.last()?.text).toContain("Écriture CA n°1 comptabilisée");
    const entries = await withTenant(db, { tenantId }, (tx) => tx`SELECT source, status FROM journal_entry WHERE tenant_id = ${tenantId}`);
    expect(entries).toEqual([{ source: "AI", status: "VALIDATED" }]);
    const messages = await withTenant(db, { tenantId }, (tx) => tx`SELECT direction, type, proposal_id FROM whatsapp_message WHERE tenant_id = ${tenantId} ORDER BY at`);
    expect(messages.filter((m) => m.direction === "IN")).toHaveLength(3);
    expect(messages.filter((m) => m.proposal_id === proposalId)).toHaveLength(3); // proposition, demande de vérification, confirmation
    const [conv] = await withTenant(db, { tenantId }, (tx) => tx`SELECT state FROM whatsapp_conversation WHERE tenant_id = ${tenantId}`);
    expect((conv!.state as { pendingProposalId?: string }).pendingProposalId).toBeUndefined();
  });

  it("photo → pièce → extraction → proposition, et anti-rejeu sur l'identifiant du message", async () => {
    provider.media.set("media-1", { bytes: JPEG, mimeType: "image/jpeg" });
    model.enqueue(JSON.stringify({ document_type: "INVOICE", supplier_name: "CIE", supplier_tax_id: null, customer_name: null, reference: "F-1", date: "2025-03-05", currency: "XOF", amount_excl_tax: "100000", vat_amount: "18000", amount_incl_tax: "118000", lines: [{ description: "Électricité", quantity: null, unit_price: null, amount: "100000" }], confidence: 0.95, notes: null }));
    model.enqueue(JSON.stringify({ account_number: "6052", vat_code: "TVA18", confidence: 0.9, rationale: "Électricité" }));
    const m = msg({ type: "IMAGE", mediaId: "media-1", mimeType: "image/jpeg" });
    await bot.handle(m);
    expect(provider.last()?.text).toBe("Facture CIE 118 000 FCFA du 05/03 → 6052 Fournitures non stockables – électricité. Valider ?");
    const sent = provider.sent.length;
    await bot.handle(m); // même identifiant : ignoré
    expect(provider.sent.length).toBe(sent);
    const docs = await withTenant(db, { tenantId }, (tx) => tx`SELECT source, status, mime_type FROM document WHERE tenant_id = ${tenantId}`);
    expect(docs).toEqual([{ source: "WHATSAPP", status: "PROPOSED", mime_type: "image/jpeg" }]);
  });
});
