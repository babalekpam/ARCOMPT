import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { loadPack, type CountryPack } from "@arcompt/country-packs";
import { PostingError } from "@arcompt/posting";
import {
  InvoicingError,
  StockService,
  type CreateStockArticleInput,
  type CreateStockCountInput,
  type InvoicingDeps,
  type RecordMovementInput,
  type UpdateStockArticleInput,
} from "@arcompt/invoicing";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

/**
 * Routes stocks — inventaire intermittent SYSCOHADA.
 *
 * Articles, mouvements, état du stock, inventaire physique et variation de
 * clôture. Aucune route n'écrit dans le grand livre : seule la clôture produit
 * des écritures, par le moteur d'imputation.
 *
 * Rôles : lecture pour tout membre du dossier ; mouvements et comptages pour
 * CASHIER, ACCOUNTANT et OWNER ; articles, validation d'inventaire et clôture
 * pour ACCOUNTANT et OWNER seulement.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const quantity = z.string().regex(/^\d+(\.\d{1,4})?$/, "quantité décimale positive (4 décimales max)");
const money = z.string().regex(/^\d+(\.\d{1,4})?$/, "montant décimal positif (4 décimales max)");
const uuid = z.string().uuid();
const account = z.string().regex(/^[1-9]\d{1,12}$/);

const CATEGORIES = ["MARCHANDISE", "MATIERE_PREMIERE", "AUTRE_APPRO", "EN_COURS", "PRODUIT_FINI", "PRODUIT_INTERMEDIAIRE"] as const;
const REASONS = ["OPENING", "PURCHASE", "PRODUCTION", "RETURN_IN", "SALE", "CONSUMPTION", "LOSS", "RETURN_OUT", "COUNT_ADJUSTMENT", "OTHER"] as const;

const ArticleSchema = z.object({
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  unit: z.string().min(1).max(20).optional(),
  category: z.enum(CATEGORIES),
  stockAccountNumber: account.optional(),
  variationAccountNumber: account.optional(),
  valuationMethod: z.enum(["CUMP", "FIFO"]).optional(),
  productId: uuid.optional(),
  active: z.boolean().optional(),
});

const UpdateArticleSchema = ArticleSchema.omit({ code: true, category: true }).partial();

const MovementSchema = z.object({
  articleId: uuid,
  date: isoDate,
  kind: z.enum(["OPENING", "IN", "OUT"]),
  reason: z.enum(REASONS).optional(),
  quantity,
  unitCost: money.optional(),
  value: money.optional(),
  reference: z.string().max(80).optional(),
  note: z.string().max(2000).optional(),
  purchaseDocumentId: uuid.optional(),
  salesDocumentId: uuid.optional(),
});

const CountSchema = z.object({
  fiscalYearCode: z.string().min(1).max(20),
  date: isoDate,
  label: z.string().max(200).optional(),
  lines: z
    .array(z.object({ articleId: uuid, countedQuantity: quantity, unitCost: money.optional(), note: z.string().max(500).optional() }))
    .min(1),
});

const CloseSchema = z.object({ fiscalYear: z.string().min(1).max(20), countId: uuid.optional(), date: isoDate.optional() });

/** Retire les clés `undefined` (zod les garde, `exactOptionalPropertyTypes` les refuse). */
function strip<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.map((x: unknown) => (x && typeof x === "object" ? strip(x as object) : x)) : v]),
  ) as T;
}

function invalid(c: Context, issues: unknown) {
  return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: issues } }, 400);
}


export function stockRoutes(deps: AppDeps) {
  const r = new Hono();
  const packs = new Map<string, CountryPack>();

  async function serviceFor(c: Context): Promise<StockService> {
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
    const sd: InvoicingDeps = { db: db as unknown as Sql, ledger: deps.ledgerFor(auth), pack, currency: String(company.currency) };
    return new StockService(sd, { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) });
  }

  r.use("*", async (c, next) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Module stocks indisponible sans base de données" } }, 503);
    return next();
  });

  r.onError((err, c) => {
    if (err instanceof InvoicingError) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.httpStatus as 400);
    if (err instanceof PostingError) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, 422);
    throw err; // LedgerError et le reste : gestion de l'application
  });

  const write = requireRole("OWNER", "ACCOUNTANT", "CASHIER");
  const manage = requireRole("OWNER", "ACCOUNTANT");

  // ---------------------------------------------------------------------------
  // Articles
  // ---------------------------------------------------------------------------
  r.get("/articles", async (c) => c.json(await (await serviceFor(c)).listArticles({ includeInactive: c.req.query("includeInactive") === "true" })));

  r.post("/articles", manage, async (c) => {
    const parsed = ArticleSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await serviceFor(c)).createArticle(strip(parsed.data) as CreateStockArticleInput), 201);
  });

  r.get("/articles/:id", async (c) => c.json(await (await serviceFor(c)).getArticle(c.req.param("id"))));

  r.patch("/articles/:id", manage, async (c) => {
    const parsed = UpdateArticleSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await serviceFor(c)).updateArticle(c.req.param("id"), strip(parsed.data) as UpdateStockArticleInput));
  });

  /** État du stock d'un article : quantité, valeur et coût unitaire à la date demandée. */
  r.get("/articles/:id/position", async (c) => {
    const asOf = c.req.query("asOf");
    const service = await serviceFor(c);
    return c.json(asOf ? await service.position(c.req.param("id"), asOf) : await service.position(c.req.param("id")));
  });

  // ---------------------------------------------------------------------------
  // Mouvements et état du stock
  // ---------------------------------------------------------------------------
  /** État de tous les articles actifs : le stock théorique du dossier. */
  r.get("/positions", async (c) => {
    const asOf = c.req.query("asOf");
    const service = await serviceFor(c);
    return c.json(asOf ? await service.positions(asOf) : await service.positions());
  });

  r.get("/movements", async (c) => {
    const q = z.object({ articleId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }).safeParse(c.req.query());
    if (!q.success) return invalid(c, q.error.issues);
    return c.json(await (await serviceFor(c)).listMovements(strip(q.data) as { articleId?: string; from?: string; to?: string }));
  });

  r.post("/movements", write, async (c) => {
    const parsed = MovementSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await serviceFor(c)).recordMovement(strip(parsed.data) as RecordMovementInput), 201);
  });

  // ---------------------------------------------------------------------------
  // Inventaire physique
  // ---------------------------------------------------------------------------
  r.get("/counts", async (c) => {
    const fiscalYear = c.req.query("fiscalYear");
    return c.json(await (await serviceFor(c)).listCounts(fiscalYear ? { fiscalYearCode: fiscalYear } : {}));
  });

  r.post("/counts", write, async (c) => {
    const parsed = CountSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await serviceFor(c)).createCount(strip(parsed.data) as CreateStockCountInput), 201);
  });

  r.get("/counts/:id", async (c) => c.json(await (await serviceFor(c)).getCount(c.req.param("id"))));

  /** Valide un comptage ; `adjust` aligne le stock théorique sur le comptage (aucune écriture). */
  r.post("/counts/:id/validate", manage, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ adjust: z.boolean().optional() }).safeParse(body ?? {});
    if (!parsed.success) return invalid(c, parsed.error.issues);
    return c.json(await (await serviceFor(c)).validateCount(c.req.param("id"), strip(parsed.data) as { adjust?: boolean }));
  });

  // ---------------------------------------------------------------------------
  // Variation de stock de fin d'exercice
  // ---------------------------------------------------------------------------
  r.get("/closings/:fiscalYear", async (c) => {
    const closing = await (await serviceFor(c)).getClosing(c.req.param("fiscalYear"));
    if (!closing) return c.json({ error: { code: "NOT_FOUND", message: "Aucune variation de stock pour cet exercice" } }, 404);
    return c.json(closing);
  });

  /**
   * Passe la variation de stock de l'exercice : annulation du stock initial puis
   * constatation du stock final inventorié. Une fois par exercice.
   */
  r.post("/closings", manage, async (c) => {
    const parsed = CloseSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const { fiscalYear, ...opts } = parsed.data;
    return c.json(await (await serviceFor(c)).closeFiscalYear(fiscalYear, strip(opts) as { countId?: string; date?: string }), 201);
  });

  return r;
}
