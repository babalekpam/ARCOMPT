// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { loadPack, type CountryPack } from "@arcompt/country-packs";
import { PostingError } from "@arcompt/posting";
import {
  InvoicingError,
  InvoicingService,
  PaymentsService,
  PurchasesService,
  type CertificationConnector,
  type DunningSender,
  type InvoicingDeps,
  type PaymentProvider,
} from "@arcompt/invoicing";
import { createProviderFromEnv } from "@arcompt/whatsapp";
import { requireRole } from "../auth.js";
import { idempotencyErrorResponse, withIdempotencyAround } from "../idempotency.js";
import type { AppDeps } from "../app.js";
import { certificationConnectorFromEnv, paymentProvidersFromEnv } from "../config.js";
import { createDunningSender, createMailer } from "../notifications.js";

/**
 * Routes facturation, achats et règlements. Montées par l'application sous un
 * préfixe (ex. /v1). Sans `deps.db`, toutes les routes répondent 503.
 *
 * Rôles : lecture pour tout membre ; brouillons et règlements pour CASHIER,
 * ACCOUNTANT, OWNER ; émission, avoirs, approbation et refus de règlement pour
 * ACCOUNTANT et OWNER seulement (l'approbateur doit en plus différer de l'auteur,
 * contrôle porté par le service).
 */
export interface InvoicingRouteDeps extends AppDeps {
  invoicing?: {
    /** Connecteur de facture certifiée ; défaut : MockFneConnector si CERTIFICATION_CONNECTOR=mock (refusé en production), sinon NullConnector. */
    certification?: CertificationConnector;
    /** Opérateurs de paiement par nom ; défaut : { mock } (secret PAYMENT_WEBHOOK_SECRET), refusé en production. */
    paymentProviders?: Record<string, PaymentProvider>;
    /** Expéditeur des relances ; défaut : e-mail (SMTP_*) et WhatsApp selon l'environnement. */
    dunningSender?: DunningSender;
    now?: () => Date;
  };
}

const money = z.string().regex(/^\d+(\.\d{1,4})?$/, "montant décimal positif (4 décimales max)");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const account = z.string().regex(/^[1-9]\d{1,12}$/);

/**
 * Identifiant de rejeu tiré par l'appareil au moment de la mise en file hors
 * ligne (docs/OFFLINE.md). Deux envois du même brouillon ne créent qu'un objet.
 */
const clientId = z.string().uuid().optional();

const ProductSchema = z.object({
  clientId,
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  defaultAccountNumber: account,
  vatCode: z.string().max(20).nullable().optional(),
  unitPrice: money.optional(),
  unit: z.string().max(20).optional(),
  active: z.boolean().optional(),
});

const SalesLineSchema = z.object({
  productId: uuid.optional(),
  label: z.string().max(300).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  unitPrice: money.optional(),
  accountNumber: account.optional(),
  vatCode: z.string().max(20).nullable().optional(),
});

const SalesDocumentSchema = z.object({
  clientId,
  kind: z.enum(["QUOTE", "INVOICE", "CREDIT_NOTE"]),
  partnerId: uuid,
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(4000).optional(),
  lines: z.array(SalesLineSchema).min(1),
});

const PurchaseLineSchema = z.object({
  accountNumber: account,
  label: z.string().min(1).max(300),
  net: money,
  vatCode: z.string().max(20).nullable().optional(),
});

const PurchaseDocumentSchema = z.object({
  clientId,
  kind: z.enum(["SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE", "EXPENSE_CLAIM"]),
  partnerId: uuid,
  reference: z.string().max(80).optional(),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(4000).optional(),
  documentId: uuid.optional(),
  lines: z.array(PurchaseLineSchema).min(1),
});

const AllocationSchema = z
  .object({ salesDocumentId: uuid.optional(), purchaseDocumentId: uuid.optional(), amount: money })
  .refine((a) => Boolean(a.salesDocumentId) !== Boolean(a.purchaseDocumentId), { message: "Exactement un de salesDocumentId ou purchaseDocumentId" });

const PaymentSchema = z.object({
  kind: z.enum(["RECEIPT", "DISBURSEMENT"]),
  method: z.enum(["BANK", "CASH", "MOBILE_MONEY", "CHEQUE"]),
  treasuryAccountNumber: z.string().regex(/^5\d{1,12}$/).optional(),
  partnerId: uuid,
  amount: money,
  date: isoDate,
  reference: z.string().max(120).optional(),
  allocations: z.array(AllocationSchema).optional(),
  provider: z.string().max(40).optional(),
  providerTxId: z.string().max(120).optional(),
});

const AsOfSchema = z.object({ asOf: isoDate.optional() });

/** Sans les `| undefined` des propriétés optionnelles, y compris dans les tableaux d'objets (exactOptionalPropertyTypes). */
type Stripped<T> = { [K in keyof T]: Exclude<T[K], undefined> extends (infer U)[] ? (U extends object ? Stripped<U>[] : U[]) : Exclude<T[K], undefined> };

/** Retire les clés `undefined` (zod garde des `| undefined` que exactOptionalPropertyTypes refuse), récursivement dans les tableaux (lignes). */
function strip<T extends object>(o: T): Stripped<T> {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.map((x: unknown) => (x && typeof x === "object" ? strip(x as object) : x)) : v]),
  ) as Stripped<T>;
}

function invalid(c: Context, issues: unknown) {
  return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: issues } }, 400);
}

/** Objets créés par ces routes : l'identifiant serveur est toujours `id`. */
function idOf(body: unknown): string | null {
  return body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : null;
}

export function invoicingRoutes(deps: InvoicingRouteDeps) {
  const r = new Hono();
  const packs = new Map<string, CountryPack>();
  // Connecteur et opérateurs simulés refusés en production (voir config.ts) :
  // une certification fiscale inventée finit imprimée sur la facture client,
  // un opérateur mock accepte des encaissements fictifs.
  const certification = deps.invoicing?.certification ?? certificationConnectorFromEnv();
  const paymentProviders = deps.invoicing?.paymentProviders ?? paymentProvidersFromEnv();
  // Expéditeur des relances : sans lui, `recordDunning` refuse d'écrire une
  // ligne « relance envoyée » qu'aucun message n'accompagne.
  const dunningSender =
    deps.invoicing?.dunningSender ??
    createDunningSender({ mailer: createMailer({ ...(deps.quiet ? { quiet: true } : {}) }), whatsapp: createProviderFromEnv() });

  /** Services liés au dossier du jeton : pack pays et devise lus sur `company`. */
  async function servicesFor(c: Context) {
    const auth = c.get("auth");
    const db = deps.db!;
    const [company] = await withTenant(db, auth, (tx) => tx`SELECT country_code, currency FROM company WHERE id = ${auth.tenantId}`);
    if (!company) throw new InvoicingError("NOT_FOUND", "Dossier introuvable");
    const code = String(company.country_code).toLowerCase();
    let pack = packs.get(code);
    if (!pack) {
      pack = loadPack(code);
      packs.set(code, pack);
    }
    const sd: InvoicingDeps = {
      db: db as unknown as Sql,
      ledger: deps.ledgerFor(auth),
      pack,
      currency: String(company.currency),
      certification,
      paymentProviders,
      dunningSender,
      ...(deps.invoicing?.now ? { now: deps.invoicing.now } : {}),
    };
    const ctx = { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) };
    return { invoicing: new InvoicingService(sd, ctx), purchases: new PurchasesService(sd, ctx), payments: new PaymentsService(sd, ctx) };
  }

  /**
   * Création rejouable depuis la file hors ligne. Sans `replayId`, le
   * comportement est inchangé : l'opération s'exécute et répond 201.
   *
   * Le service ouvrant sa propre transaction, la trace de rejeu est posée
   * autour (docs/OFFLINE.md, apps/api/src/idempotency.ts).
   */
  async function replayable<T>(c: Context, replayId: string | undefined, operation: string, resourceKind: string, body: unknown, run: () => Promise<T>) {
    const auth = c.get("auth");
    const ctx = { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) };
    try {
      const out = await withIdempotencyAround({ db: deps.db!, ctx, clientId: replayId, operation, body, resourceKind }, run, idOf);
      if (out.replayed) c.header("Idempotent-Replay", "true");
      return c.json(out.body as object, out.replayed ? 200 : 201);
    } catch (e) {
      const mapped = idempotencyErrorResponse(e);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw e;
    }
  }

  r.use("*", async (c, next) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Module facturation indisponible sans base de données" } }, 503);
    return next();
  });

  r.onError((err, c) => {
    if (err instanceof InvoicingError) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.httpStatus as 400);
    if (err instanceof PostingError) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, 422);
    throw err; // LedgerError et le reste : gestion de l'application
  });

  const write = requireRole("OWNER", "ACCOUNTANT", "CASHIER");
  const issue = requireRole("OWNER", "ACCOUNTANT");
  async function reminderNeedsReview(c: Context, invoiceId: string): Promise<boolean> {
    if (!deps.jobStatusSupported) return false;
    const auth = c.get("auth");
    const [row] = await withTenant(deps.db!, auth, (tx) => tx`
      SELECT 1 FROM background_job j
      WHERE j.tenant_id = ${auth.tenantId} AND j.name = 'dunning.send'
        AND j.status = 'FAILED' AND j.payload->>'invoiceId' = ${invoiceId}
        AND NOT EXISTS (SELECT 1 FROM background_job_review r WHERE r.source_job_id = j.id)
      LIMIT 1`);
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------
  r.get("/products", async (c) => {
    const { invoicing } = await servicesFor(c);
    return c.json(await invoicing.listProducts({ includeInactive: c.req.query("includeInactive") === "true" }));
  });
  r.post("/products", issue, async (c) => {
    const parsed = ProductSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const { clientId: replayId, ...input } = parsed.data;
    const { invoicing } = await servicesFor(c);
    return replayable(c, replayId, "product.create", "product", input, () => invoicing.createProduct(strip(input)));
  });
  r.get("/products/:id", async (c) => c.json(await (await servicesFor(c)).invoicing.getProduct(c.req.param("id"))));
  r.put("/products/:id", issue, async (c) => {
    const parsed = ProductSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.updateProduct(c.req.param("id"), strip(parsed.data)));
  });

  // -------------------------------------------------------------------------
  // Ventes : devis, factures, avoirs
  // -------------------------------------------------------------------------
  r.get("/sales", async (c) => {
    const q = z
      .object({ kind: z.enum(["QUOTE", "INVOICE", "CREDIT_NOTE"]).optional(), status: z.enum(["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED", "ACCEPTED", "REFUSED"]).optional(), partnerId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.list(strip(q.data)));
  });
  r.post("/sales", write, async (c) => {
    const parsed = SalesDocumentSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const { clientId: replayId, ...input } = parsed.data;
    const { invoicing } = await servicesFor(c);
    return replayable(c, replayId, "sales.draft", "sales_document", input, () => invoicing.createDraft(strip(input)));
  });
  r.get("/sales/:id", async (c) => c.json(await (await servicesFor(c)).invoicing.get(c.req.param("id"))));
  r.put("/sales/:id", write, async (c) => {
    const parsed = SalesDocumentSchema.omit({ kind: true }).partial().safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.updateDraft(c.req.param("id"), strip(parsed.data)));
  });
  r.post("/sales/:id/issue", issue, async (c) => c.json(await (await servicesFor(c)).invoicing.issue(c.req.param("id"))));
  r.post("/sales/:id/cancel", write, async (c) => c.json(await (await servicesFor(c)).invoicing.cancel(c.req.param("id"))));
  r.post("/sales/:id/status", write, async (c) => {
    const parsed = z.object({ status: z.enum(["ACCEPTED", "REFUSED"]) }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.setQuoteStatus(c.req.param("id"), parsed.data.status));
  });
  r.post("/sales/:id/convert", write, async (c) => {
    const parsed = z.object({ issueDate: isoDate, dueDate: isoDate.optional() }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.convertQuote(c.req.param("id"), strip(parsed.data)), 201);
  });
  r.post("/sales/:id/credit-note", issue, async (c) => {
    const parsed = z.object({ issueDate: isoDate, notes: z.string().max(4000).optional(), lines: z.array(SalesLineSchema).min(1).optional() }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.createCreditNote(c.req.param("id"), strip(parsed.data)), 201);
  });
  r.get("/sales/:id/pdf-data", async (c) => c.json(await (await servicesFor(c)).invoicing.getPdfData(c.req.param("id"))));
  r.post("/sales/:id/payment-link", write, async (c) => {
    const parsed = z.object({ provider: z.string().min(1).max(40).default("mock") }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).payments.createPaymentLink(c.req.param("id"), parsed.data.provider), 201);
  });
  r.get("/sales/:id/payment-links", async (c) => c.json(await (await servicesFor(c)).payments.listPaymentLinks(c.req.param("id"))));
  r.post("/sales/:id/dunning", write, async (c) => {
    const parsed = z.object({ level: z.number().int().min(1).max(5), channel: z.enum(["EMAIL", "WHATSAPP", "SMS"]), message: z.string().max(4000).optional() }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    if (await reminderNeedsReview(c, c.req.param("id")))
      return c.json({ error: { code: "REVIEW_REQUIRED", message: "Vérifiez d'abord la livraison du rappel en échec dans Opérations" } }, 409);
    return c.json(await (await servicesFor(c)).invoicing.recordDunning(c.req.param("id"), strip(parsed.data)), 201);
  });
  r.post("/sales/:id/dunning/schedule", write, async (c) => {
    if (!deps.jobs) return c.json({ error: { code: "UNAVAILABLE", message: "File de tâches indisponible" } }, 503);
    const parsed = z.object({
      channel: z.enum(["EMAIL", "WHATSAPP", "SMS"]),
      level: z.number().int().min(1).max(5).optional(),
      delayMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000),
      requestId: uuid,
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    if (await reminderNeedsReview(c, c.req.param("id")))
      return c.json({ error: { code: "REVIEW_REQUIRED", message: "Vérifiez d'abord la livraison du rappel en échec dans Opérations" } }, 409);
    const auth = c.get("auth");
    const job = await deps.jobs.enqueue("dunning.send", {
      tenantId: auth.tenantId, userId: auth.userId, invoiceId: c.req.param("id"),
      channel: parsed.data.channel, ...(parsed.data.level ? { level: parsed.data.level } : {}),
    }, { delayMs: parsed.data.delayMs, jobId: `dunning-${parsed.data.requestId}` });
    return c.json(job, 202);
  });

  // -------------------------------------------------------------------------
  // Achats
  // -------------------------------------------------------------------------
  r.get("/purchases", async (c) => {
    const q = z
      .object({ kind: z.enum(["SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE", "EXPENSE_CLAIM"]).optional(), status: z.enum(["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"]).optional(), partnerId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await servicesFor(c)).purchases.list(strip(q.data)));
  });
  r.post("/purchases", write, async (c) => {
    const parsed = PurchaseDocumentSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const { clientId: replayId, ...input } = parsed.data;
    const { purchases } = await servicesFor(c);
    return replayable(c, replayId, "purchase.draft", "purchase_document", input, () => purchases.createDraft(strip(input)));
  });
  r.get("/purchases/:id", async (c) => c.json(await (await servicesFor(c)).purchases.get(c.req.param("id"))));
  r.put("/purchases/:id", write, async (c) => {
    const parsed = PurchaseDocumentSchema.omit({ kind: true }).partial().safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).purchases.updateDraft(c.req.param("id"), strip(parsed.data)));
  });
  r.post("/purchases/:id/issue", issue, async (c) => c.json(await (await servicesFor(c)).purchases.issue(c.req.param("id"))));
  r.post("/purchases/:id/cancel", write, async (c) => c.json(await (await servicesFor(c)).purchases.cancel(c.req.param("id"))));
  r.post("/purchases/:id/credit-note", issue, async (c) => {
    const parsed = z.object({ issueDate: isoDate, reference: z.string().max(80).optional(), notes: z.string().max(4000).optional(), lines: z.array(PurchaseLineSchema).min(1).optional() }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).purchases.createCreditNote(c.req.param("id"), strip(parsed.data)), 201);
  });

  // -------------------------------------------------------------------------
  // Règlements
  // -------------------------------------------------------------------------
  r.get("/payments", async (c) => {
    const q = z
      .object({ kind: z.enum(["RECEIPT", "DISBURSEMENT"]).optional(), status: z.enum(["RECORDED", "PENDING_APPROVAL", "REVIEW", "REJECTED"]).optional(), partnerId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await servicesFor(c)).payments.list(strip(q.data)));
  });
  // Le caissier enregistre les règlements ; au-delà du seuil, l'approbation d'un OWNER/ACCOUNTANT différent est requise.
  r.post("/payments", write, async (c) => {
    const parsed = PaymentSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).payments.record(strip(parsed.data)), 201);
  });
  // Webhook opérateur : corps brut vérifié par HMAC ; 401 si signature invalide (journalisée), 409 si rejeu.
  // Sous l'authentification de l'application telle que montée : le tenant vient du jeton.
  r.post("/payments/webhook/:provider", async (c) => {
    const rawBody = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const outcome = await (await servicesFor(c)).payments.handleWebhook(c.req.param("provider"), rawBody, headers);
    return c.json(outcome, outcome.outcome === "processed" || outcome.outcome === "review" ? 201 : 200);
  });
  r.get("/payments/:id", async (c) => c.json(await (await servicesFor(c)).payments.get(c.req.param("id"))));
  r.post("/payments/:id/allocate", write, async (c) => {
    const parsed = z.object({ allocations: z.array(AllocationSchema).min(1) }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).payments.allocate(c.req.param("id"), strip(parsed.data).allocations));
  });
  r.post("/payments/:id/approve", issue, async (c) => {
    const parsed = z.object({ allocations: z.array(AllocationSchema).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).payments.approve(c.req.param("id"), strip(parsed.data)));
  });
  r.post("/payments/:id/reject", issue, async (c) => {
    const parsed = z.object({ reason: z.string().min(1).max(1000) }).safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await servicesFor(c)).payments.reject(c.req.param("id"), parsed.data.reason));
  });

  // -------------------------------------------------------------------------
  // Balance âgée et relances
  // -------------------------------------------------------------------------
  const today = () => (deps.invoicing?.now?.() ?? new Date()).toISOString().slice(0, 10);
  r.get("/receivables/aged", async (c) => {
    const q = AsOfSchema.safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.getAgedReceivables(q.data.asOf ?? today()));
  });
  r.get("/payables/aged", async (c) => {
    const q = AsOfSchema.safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await servicesFor(c)).purchases.getAgedPayables(q.data.asOf ?? today()));
  });
  r.get("/dunning/overdue", async (c) => {
    const q = AsOfSchema.safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await servicesFor(c)).invoicing.listOverdue(q.data.asOf ?? today()));
  });

  return r;
}
