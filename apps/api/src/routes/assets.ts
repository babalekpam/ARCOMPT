// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTenant } from "@arcompt/db";
import { AssetsError, AssetsService, type CreateAssetInput, type UpdateAssetInput } from "@arcompt/assets";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const accountNumber = z.string().regex(/^[1-9]\d{1,12}$/);

const AcquisitionSchema = z.object({
  journalCode: z.string().min(1).max(8).optional(),
  counterpartAccount: accountNumber,
  partnerId: z.string().uuid().optional(),
  date: isoDate.optional(),
  reference: z.string().max(60).optional(),
  vat: z.object({ amount: money, account: accountNumber.optional(), vatCode: z.string().optional() }).optional(),
});

const CreateAssetSchema = z.object({
  label: z.string().min(1).max(200),
  reference: z.string().max(60).optional(),
  category: z.enum(["INCORPORELLE", "CORPORELLE", "FINANCIERE"]).optional(),
  accountNumber,
  depreciationAccountNumber: accountNumber.optional(),
  expenseAccountNumber: accountNumber.optional(),
  acquiredOn: isoDate,
  inServiceOn: isoDate.optional(),
  cost: money,
  residualValue: money.optional(),
  method: z.enum(["LINEAR", "DEGRESSIVE", "NONE"]).optional(),
  durationMonths: z.number().int().positive().optional(),
  prorata: z.enum(["DAYS", "MONTHS"]).optional(),
  degressiveCoefficient: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  priorDepreciation: money.optional(),
  acquisition: AcquisitionSchema.optional(),
});

const UpdateAssetSchema = CreateAssetSchema.omit({ acquisition: true, accountNumber: true }).partial();

/** Retire les clés `undefined` (exactOptionalPropertyTypes). */
function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function errorStatus(code: AssetsError["code"]): 404 | 409 | 422 {
  if (code === "NOT_FOUND") return 404;
  if (code === "ALREADY_DISPOSED" || code === "ALREADY_DEPRECIATED") return 409;
  return 422;
}

export function assetsRoutes(deps: AppDeps) {
  const r = new Hono();

  const service = async (c: Context): Promise<AssetsService | null> => {
    if (!deps.db) return null;
    const auth = c.get("auth");
    const [company] = await withTenant(deps.db, auth, (tx) => tx`SELECT currency FROM company WHERE id = ${auth.tenantId}`);
    return new AssetsService({ db: deps.db, ledger: deps.ledgerFor(auth), ctx: auth, currency: (company?.currency as string | undefined) ?? "XOF" });
  };

  const unavailable = (c: Context) => c.json({ error: { code: "DB_UNAVAILABLE", message: "Base de données indisponible" } }, 503);

  const guard = (fn: (c: Context, s: AssetsService) => Promise<Response>) => async (c: Context) => {
    const s = await service(c);
    if (!s) return unavailable(c);
    try {
      return await fn(c, s);
    } catch (e) {
      if (e instanceof AssetsError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, errorStatus(e.code));
      throw e;
    }
  };

  r.get(
    "/",
    guard(async (c, s) => c.json(await s.list({ includeDisposed: c.req.query("includeDisposed") === "true" }))),
  );

  r.post(
    "/",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const parsed = CreateAssetSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
      const { acquisition, ...rest } = parsed.data;
      const input = { ...strip(rest), ...(acquisition ? { acquisition: strip({ ...acquisition, ...(acquisition.vat ? { vat: strip(acquisition.vat) } : {}) }) } : {}) } as CreateAssetInput;
      return c.json(await s.create(input), 201);
    }),
  );

  // Routes fixes avant « /:id ».
  r.get(
    "/notes",
    guard(async (c, s) => {
      const q = z.object({ fiscalYear: z.string().min(1) }).safeParse(c.req.query());
      if (!q.success) return c.json({ error: { code: "VALIDATION", message: "fiscalYear requis" } }, 400);
      return c.json(await s.notes3A3C(q.data.fiscalYear));
    }),
  );

  r.post(
    "/run-depreciation",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const parsed = z.object({ fiscalYear: z.string().min(1), upToDate: isoDate.optional() }).safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "fiscalYear requis", details: parsed.error.issues } }, 400);
      return c.json(await s.runDepreciation(parsed.data.fiscalYear, parsed.data.upToDate));
    }),
  );

  r.get(
    "/:id",
    guard(async (c, s) => c.json(await s.get(c.req.param("id")!))),
  );

  r.patch(
    "/:id",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const parsed = UpdateAssetSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
      return c.json(await s.update(c.req.param("id")!, strip(parsed.data) as UpdateAssetInput));
    }),
  );

  r.delete(
    "/:id",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      await s.remove(c.req.param("id")!);
      return c.body(null, 204);
    }),
  );

  r.get(
    "/:id/schedule",
    guard(async (c, s) => c.json(await s.schedule(c.req.param("id")!))),
  );

  r.post(
    "/:id/dispose",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const parsed = z
        .object({ date: isoDate, price: money, treasuryAccount: accountNumber.default("521"), partnerId: z.string().uuid().optional(), label: z.string().max(200).optional() })
        .safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
      const { date, price, treasuryAccount, ...opts } = parsed.data;
      return c.json(await s.dispose(c.req.param("id")!, date, price, treasuryAccount, strip(opts) as { partnerId?: string; label?: string }));
    }),
  );

  return r;
}
