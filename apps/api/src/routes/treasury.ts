import { Hono, type Context } from "hono";
import { z } from "zod";
import { httpStatusOf, TreasuryError, TreasuryService, type LlmMatcher, type StatementImportInput } from "@arcompt/treasury";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

/**
 * Routes trésorerie. Montées par l'application sous un préfixe (ex. /v1/treasury).
 * Sans `deps.db`, toutes les routes répondent 503 : le module exige PostgreSQL.
 */
export interface TreasuryRouteDeps extends AppDeps {
  treasury?: {
    llmMatcher?: LlmMatcher;
    matchThreshold?: number;
    dateWindowDays?: number;
    cashAnomalyThreshold?: string;
  };
}

const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/, "montant décimal (4 décimales max)");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

const AccountSchema = z.object({
  kind: z.enum(["BANK", "CASH", "MOBILE_MONEY"]),
  label: z.string().min(1).max(120),
  accountNumber: z.string().regex(/^5\d{1,12}$/),
  currency: z.string().length(3),
  bankName: z.string().max(120).optional(),
  iban: z.string().max(64).optional(),
  mmOperator: z.string().max(60).optional(),
  mmPhone: z.string().max(30).optional(),
  active: z.boolean().optional(),
});

const RowSchema = z.object({
  date: isoDate,
  valueDate: isoDate.optional(),
  label: z.string().max(300),
  amount: money,
  reference: z.string().max(120).optional(),
  externalId: z.string().max(120).optional(),
});

const CsvOptionsSchema = z.object({
  separator: z.string().length(1).optional(),
  dateFormat: z.enum(["DMY", "YMD", "MDY"]).optional(),
  decimalSeparator: z.enum([",", "."]).optional(),
  hasHeader: z.boolean().optional(),
  bankPerspective: z.boolean().optional(),
  columns: z.record(z.union([z.string(), z.number().int().nonnegative()])).optional(),
});

const ImportOptionsSchema = z.object({
  periodFrom: isoDate.optional(),
  periodTo: isoDate.optional(),
  openingBalance: money.optional(),
  closingBalance: money.optional(),
  source: z.enum(["CSV", "PDF", "SMS", "API"]).optional(),
  documentId: uuid.optional(),
});

const ImportBodySchema = ImportOptionsSchema.extend({
  rows: z.array(RowSchema).min(1).optional(),
  csv: z.string().min(1).optional(),
  csvOptions: CsvOptionsSchema.optional(),
  sms: z.string().min(1).optional(),
  smsOptions: z.object({ defaultDate: isoDate.optional(), includeFees: z.boolean().optional() }).optional(),
}).refine((b) => [b.rows, b.csv, b.sms].filter((x) => x !== undefined).length === 1, { message: "Fournir exactement un de rows, csv ou sms" });

const PostBodySchema = z.object({
  accountNumber: z.string().regex(/^[1-9]\d{1,12}$/),
  partnerId: uuid.optional(),
  label: z.string().max(200).optional(),
  ruleId: uuid.optional(),
  journalCode: z.string().min(1).max(8).optional(),
  vatCode: z.string().max(20).optional(),
});

const RuleSchema = z.object({
  treasuryAccountId: uuid.optional(),
  pattern: z.string().min(1).max(200),
  isRegex: z.boolean().optional(),
  accountNumber: z.string().regex(/^[1-9]\d{1,12}$/),
  partnerId: uuid.optional(),
  label: z.string().max(120).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

const CashCountSchema = z.object({
  date: isoDate,
  countedAmount: money,
  note: z.string().max(500).optional(),
  postDifference: z.boolean().optional(),
});

const ForecastSchema = z.object({
  asOf: isoDate,
  openingBalance: money.optional(),
  accountIds: z.array(uuid).optional(),
  receivables: z.array(z.object({ dueDate: isoDate, amount: money, label: z.string().max(120).optional() })).optional(),
  payables: z.array(z.object({ dueDate: isoDate, amount: money, label: z.string().max(120).optional() })).optional(),
  recurring: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        amount: money,
        direction: z.enum(["IN", "OUT"]),
        frequency: z.enum(["WEEKLY", "MONTHLY"]),
        dayOfMonth: z.number().int().min(1).max(31).optional(),
        weekday: z.number().int().min(0).max(6).optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
      }),
    )
    .optional(),
  weeks: z.number().int().min(1).max(52).optional(),
  minimumBalance: money.optional(),
});

const MatchOptionsSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
  dateWindowDays: z.number().int().min(0).max(30).optional(),
});

/** Type sans `undefined` explicite sur les propriétés optionnelles (exactOptionalPropertyTypes). */
type NoUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/** Retire les clés undefined : exactOptionalPropertyTypes refuse `x: undefined`. */
function strip<T extends object>(o: T): NoUndefined<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as NoUndefined<T>;
}

/** Paramètre de chemin ; le typage par chemin est perdu derrière `guard`, mais la route garantit sa présence. */
function param(c: Context, name: string): string {
  return c.req.param(name) ?? "";
}

function validationError(c: Context, issues: unknown) {
  return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: issues } }, 400);
}

export function treasuryRoutes(deps: TreasuryRouteDeps) {
  const r = new Hono();

  r.use("*", async (c, next) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Module trésorerie indisponible : base de données non configurée" } }, 503);
    return next();
  });

  const service = (c: Context) => {
    const auth = c.get("auth");
    const t = deps.treasury ?? {};
    return new TreasuryService({
      db: deps.db!,
      ledger: deps.ledgerFor(auth),
      ctx: { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) },
      ...(t.llmMatcher ? { llmMatcher: t.llmMatcher } : {}),
      ...(t.matchThreshold !== undefined ? { matchThreshold: t.matchThreshold } : {}),
      ...(t.dateWindowDays !== undefined ? { dateWindowDays: t.dateWindowDays } : {}),
      ...(t.cashAnomalyThreshold !== undefined ? { cashAnomalyThreshold: t.cashAnomalyThreshold } : {}),
    });
  };

  /** Convertit les erreurs métier du module en réponses HTTP ; le reste remonte à app.onError (LedgerError, 500). */
  const guard = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof TreasuryError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, httpStatusOf(e.code));
      throw e;
    }
  };

  const readJson = (c: Context) => c.req.json().catch(() => ({}));
  const manage = requireRole("OWNER", "ACCOUNTANT");
  const operate = requireRole("OWNER", "ACCOUNTANT", "CASHIER");

  // ----- Comptes de trésorerie -----
  r.get("/accounts", guard(async (c) => c.json(await service(c).listAccounts({ includeInactive: c.req.query("includeInactive") === "true" }))));

  r.post("/accounts", manage, guard(async (c) => {
    const parsed = AccountSchema.safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return c.json(await service(c).createAccount(strip(parsed.data)), 201);
  }));

  r.get("/accounts/:id", guard(async (c) => c.json(await service(c).getAccount(param(c, "id")))));

  r.patch("/accounts/:id", manage, guard(async (c) => {
    const parsed = AccountSchema.partial().safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return c.json(await service(c).updateAccount(param(c, "id"), strip(parsed.data)));
  }));

  r.delete("/accounts/:id", manage, guard(async (c) => {
    const result = await service(c).deleteAccount(param(c, "id"));
    return result.deleted ? c.body(null, 204) : c.json(result.account);
  }));

  // ----- Relevés -----
  r.get("/accounts/:id/statements", guard(async (c) => c.json(await service(c).listStatements(param(c, "id")))));

  r.post("/accounts/:id/statements", operate, guard(async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let input: StatementImportInput;
    let opts: z.infer<typeof ImportOptionsSchema>;
    if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
      // Corps brut : CSV (text/csv) ou SMS (text/plain) ; options en paramètres de requête.
      const q = ImportOptionsSchema.safeParse(c.req.query());
      if (!q.success) return validationError(c, q.error.issues);
      const text = await c.req.text();
      if (!text.trim()) return validationError(c, [{ message: "Corps vide" }]);
      opts = q.data;
      input = contentType.includes("text/csv") || q.data.source === "CSV" ? { csv: text } : { sms: text };
    } else {
      const parsed = ImportBodySchema.safeParse(await readJson(c));
      if (!parsed.success) return validationError(c, parsed.error.issues);
      const { rows, csv, csvOptions, sms, smsOptions, ...rest } = parsed.data;
      opts = rest;
      if (rows) input = { rows: rows.map(strip) };
      else if (csv) input = { csv, ...(csvOptions ? { csvOptions: strip(csvOptions) as never } : {}) };
      else input = { sms: sms!, ...(smsOptions ? { smsOptions: strip(smsOptions) } : {}) };
    }
    const result = await service(c).importStatement(param(c, "id"), input, strip(opts));
    return c.json(result, 201);
  }));

  r.get("/statements/:id", guard(async (c) => c.json(await service(c).getStatement(param(c, "id")))));

  r.get("/statements/:id/transactions", guard(async (c) => {
    const status = z.enum(["UNMATCHED", "MATCHED", "IGNORED"]).optional().safeParse(c.req.query("status"));
    if (!status.success) return validationError(c, status.error.issues);
    return c.json(await service(c).listTransactions(param(c, "id"), status.data ? { status: status.data } : {}));
  }));

  // ----- Lignes de relevé -----
  r.get("/transactions/:id", guard(async (c) => c.json(await service(c).getTransaction(param(c, "id")))));

  r.get("/transactions/:id/candidates", guard(async (c) => c.json(await service(c).candidateLines(param(c, "id")))));

  r.post("/transactions/:id/match", manage, guard(async (c) => {
    const parsed = z.object({ lineId: uuid }).safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return c.json(await service(c).manualMatch(param(c, "id"), parsed.data.lineId));
  }));

  r.post("/transactions/:id/unmatch", manage, guard(async (c) => c.json(await service(c).unmatch(param(c, "id")))));

  r.post("/transactions/:id/ignore", manage, guard(async (c) => c.json(await service(c).ignore(param(c, "id")))));

  r.post("/transactions/:id/post", manage, guard(async (c) => {
    const parsed = PostBodySchema.safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return c.json(await service(c).createEntryFromTransaction(param(c, "id"), strip(parsed.data)), 201);
  }));

  // ----- Rapprochement -----
  r.post("/accounts/:id/auto-match", manage, guard(async (c) => {
    const parsed = MatchOptionsSchema.extend({ statementId: uuid.optional() }).safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const { statementId, ...options } = parsed.data;
    const svc = service(c);
    return c.json(statementId ? await svc.autoMatch(statementId, strip(options)) : await svc.autoMatchAccount(param(c, "id"), strip(options)));
  }));

  r.get("/accounts/:id/reconciliation", guard(async (c) => {
    const q = z.object({ asOf: isoDate.optional() }).safeParse(c.req.query());
    if (!q.success) return validationError(c, q.error.issues);
    return c.json(await service(c).reconciliationReport(param(c, "id"), q.data.asOf ?? new Date().toISOString().slice(0, 10)));
  }));

  // ----- Caisse -----
  r.get("/cash/:id/counts", guard(async (c) => c.json(await service(c).listCashCounts(param(c, "id")))));

  r.post("/cash/:id/count", operate, guard(async (c) => {
    const parsed = CashCountSchema.safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    // Un caissier compte ; seul un comptable ou le dirigeant comptabilise l'écart.
    const roles = c.get("auth").roles;
    if (parsed.data.postDifference && !roles.some((x) => x === "OWNER" || x === "ACCOUNTANT")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Comptabiliser un écart de caisse exige le rôle OWNER ou ACCOUNTANT" } }, 403);
    }
    return c.json(await service(c).recordCashCount(param(c, "id"), strip(parsed.data)), 201);
  }));

  // ----- Règles d'imputation -----
  r.get("/rules", guard(async (c) => c.json(await service(c).listRules())));

  r.post("/rules", manage, guard(async (c) => {
    const parsed = RuleSchema.safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return c.json(await service(c).createRule(strip(parsed.data)), 201);
  }));

  r.delete("/rules/:id", manage, guard(async (c) => {
    await service(c).deleteRule(param(c, "id"));
    return c.body(null, 204);
  }));

  // ----- Prévision 13 semaines -----
  r.post("/forecast", guard(async (c) => {
    const parsed = ForecastSchema.safeParse(await readJson(c));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const { asOf, receivables, payables, recurring, ...inputs } = parsed.data;
    const clean = {
      ...strip(inputs),
      ...(receivables ? { receivables: receivables.map(strip) } : {}),
      ...(payables ? { payables: payables.map(strip) } : {}),
      ...(recurring ? { recurring: recurring.map(strip) } : {}),
    };
    return c.json(await service(c).forecast(asOf, clean));
  }));

  return r;
}
