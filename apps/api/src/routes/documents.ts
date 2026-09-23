// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTenant } from "@arcompt/db";
import {
  AiGatewayError,
  AssistantTools,
  DocumentsError,
  askAssistant,
  createDocumentsInfraFromEnv,
  createDocumentsServiceFromEnv,
  detectAnomalies,
  documentsErrorStatus,
  type DocumentsService,
  type ProposalLine,
  type ReviewQueueFilter,
} from "@arcompt/documents";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

/**
 * Pièces, capture IA, file de revue, assistant et anomalies.
 * À monter à la racine de l'API authentifiée (ex. `api.route("/", documentsRoutes(deps))`) :
 * les chemins sont /documents, /proposals, /assistant/ask, /anomalies.
 * Sans `deps.db`, toutes les routes répondent 503.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/);

const Base64UploadSchema = z.object({
  filename: z.string().max(200).optional(),
  mimeType: z.string().max(100).optional(),
  base64: z.string().min(1),
  source: z.enum(["UPLOAD", "WHATSAPP", "EMAIL", "BANK"]).optional(),
});

const LineSchema = z.object({
  account_number: z.string().regex(/^[1-9]\d{1,12}$/),
  debit: money.optional(),
  credit: money.optional(),
  label: z.string().max(200).optional(),
  vat_code: z.string().max(20).optional(),
  partner_id: z.string().uuid().optional(),
});

const QueueQuerySchema = z.object({
  status: z.enum(["PENDING", "VALIDATED", "CORRECTED", "REJECTED"]).optional(),
  route: z.enum(["ONE_TAP_VALIDATION", "REVIEW_QUEUE", "REJECTED", "ALL"]).optional(),
  source: z.enum(["UPLOAD", "WHATSAPP", "EMAIL", "BANK"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function documentsRoutes(deps: AppDeps) {
  const r = new Hono();

  r.use("*", async (c, next) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Module pièces indisponible : aucune base de données configurée" } }, 503);
    return next();
  });

  const service = (c: Context): DocumentsService => createDocumentsServiceFromEnv(deps.db!, c.get("auth"));

  r.onError((err, c) => {
    if (err instanceof DocumentsError) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, documentsErrorStatus(err.code));
    if (err instanceof AiGatewayError) {
      const status = err.code === "QUOTA_EXCEEDED" ? 429 : err.code === "PROVIDER_ERROR" ? 502 : 422;
      return c.json({ error: { code: err.code, message: err.code === "PROVIDER_ERROR" ? "Le fournisseur IA est momentanément indisponible" : err.message } }, status);
    }
    throw err; // LedgerError et le reste : gestionnaire global de l'application
  });

  // ---- Pièces -------------------------------------------------------------
  r.post("/documents", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let bytes: Uint8Array;
    let filename: string | undefined;
    let mimeType: string | undefined;
    let source: "UPLOAD" | "WHATSAPP" | "EMAIL" | "BANK" | undefined;
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) return c.json({ error: { code: "VALIDATION", message: "Champ multipart « file » requis" } }, 400);
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      mimeType = file.type;
      const s = body["source"];
      if (typeof s === "string" && ["UPLOAD", "WHATSAPP", "EMAIL", "BANK"].includes(s)) source = s as typeof source;
    } else {
      const parsed = Base64UploadSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide : { base64, filename?, mimeType? } attendu", details: parsed.error.issues } }, 400);
      bytes = new Uint8Array(Buffer.from(parsed.data.base64, "base64"));
      filename = parsed.data.filename;
      mimeType = parsed.data.mimeType;
      source = parsed.data.source;
    }
    const result = await service(c).upload({ bytes, ...(filename ? { filename } : {}), ...(mimeType ? { mimeType } : {}), ...(source ? { source } : {}) });
    return c.json(result, result.duplicate ? 200 : 201);
  });

  r.get("/documents/:id", async (c) => c.json(await service(c).getDocument(c.req.param("id"))));

  r.get("/documents/:id/download", async (c) => {
    const svc = service(c);
    const { document, url } = await svc.downloadUrl(c.req.param("id"));
    if (!url.startsWith("file://")) return c.redirect(url, 302);
    // Stockage local : l'API sert les octets elle-même, hors de l'origine de l'application web.
    const { bytes, contentType } = await svc.downloadBytes(document.id);
    c.header("content-type", contentType);
    c.header("content-disposition", `attachment; filename="${(document.filename ?? document.id).replace(/[^\w.-]/g, "_")}"`);
    c.header("x-content-type-options", "nosniff");
    return c.body(bytes.slice().buffer as ArrayBuffer);
  });

  r.post("/documents/:id/extract", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => c.json(await service(c).extract(c.req.param("id"))));
  r.post("/documents/:id/propose", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => c.json(await service(c).propose(c.req.param("id")), 201));

  // ---- Propositions / file de revue ---------------------------------------
  r.get("/proposals", async (c) => {
    const q = QueueQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "Filtre invalide", details: q.error.issues } }, 400);
    return c.json(await service(c).reviewQueue(strip(q.data) as ReviewQueueFilter));
  });

  r.post("/proposals/bulk-validate", requireRole("OWNER", "ACCOUNTANT"), async (c) => {
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION", message: "{ ids: uuid[] } attendu" } }, 400);
    return c.json(await service(c).bulkValidate(body.data.ids));
  });

  r.get("/proposals/:id", async (c) => c.json(await service(c).getProposal(c.req.param("id"))));

  r.post("/proposals/:id/validate", requireRole("OWNER", "ACCOUNTANT"), async (c) => c.json(await service(c).validate(c.req.param("id"))));

  r.post("/proposals/:id/correct", requireRole("OWNER", "ACCOUNTANT"), async (c) => {
    const body = z.object({ lines: z.array(LineSchema).min(2) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION", message: "{ lines: [...] } attendu", details: body.error.issues } }, 400);
    return c.json(await service(c).correct(c.req.param("id"), body.data.lines.map(strip) as ProposalLine[]));
  });

  r.post("/proposals/:id/reject", requireRole("OWNER", "ACCOUNTANT"), async (c) => {
    const body = z.object({ reason: z.string().max(500).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
    return c.json(await service(c).reject(c.req.param("id"), body.success ? body.data.reason : undefined));
  });

  // ---- Assistant -----------------------------------------------------------
  r.post("/assistant/ask", async (c) => {
    const body = z.object({ question: z.string().min(2).max(2000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION", message: "{ question } attendu" } }, 400);
    const auth = c.get("auth");
    const infra = createDocumentsInfraFromEnv(deps.db!);
    const tools = new AssistantTools({ db: deps.db!, ctx: auth, ledger: deps.ledgerFor(auth), baseCurrency: infra.baseCurrency });
    return c.json(await askAssistant(infra.gateway, tools, auth, body.data.question));
  });

  // ---- Anomalies -----------------------------------------------------------
  r.get("/anomalies", requireRole("OWNER", "ACCOUNTANT", "AUDITOR", "REVIEWER"), async (c) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "from / to au format AAAA-MM-JJ" } }, 400);
    const today = new Date().toISOString().slice(0, 10);
    const period = { from: q.data.from ?? `${today.slice(0, 4)}-01-01`, to: q.data.to ?? today };
    const auth = c.get("auth");
    const anomalies = await withTenant(deps.db!, auth, (tx) => detectAnomalies(tx, auth.tenantId, period));
    return c.json({ period, anomalies });
  });

  return r;
}
