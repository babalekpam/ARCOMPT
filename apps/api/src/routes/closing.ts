// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTenant } from "@arcompt/db";
import { ClosingError, ClosingService } from "@arcompt/closing";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

const WORKFLOW_STATES = ["TENUE", "REVISION", "ETATS", "VISA", "DEPOT", "VERROUILLE"] as const;

function errorStatus(code: ClosingError["code"]): 403 | 404 | 409 | 422 {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
    case "SEPARATION_OF_DUTIES":
      return 403;
    case "INVALID_STATE":
    case "INVALID_TRANSITION":
    case "CHECKLIST_INCOMPLETE":
    case "PERIODS_OPEN":
    case "CONTROLS_FAILED":
      return 409;
    default:
      return 422;
  }
}

export function closingRoutes(deps: AppDeps) {
  const r = new Hono();

  const service = async (c: Context): Promise<ClosingService | null> => {
    if (!deps.db) return null;
    const auth = c.get("auth");
    const [company] = await withTenant(deps.db, auth, (tx) => tx`SELECT currency, accounting_system FROM company WHERE id = ${auth.tenantId}`);
    return new ClosingService({
      db: deps.db,
      ledger: deps.ledgerFor(auth),
      ctx: auth,
      currency: (company?.currency as string | undefined) ?? "XOF",
      system: (company?.accounting_system as "NORMAL" | "SMT" | undefined) ?? "NORMAL",
    });
  };

  const guard = (fn: (c: Context, s: ClosingService) => Promise<Response>) => async (c: Context) => {
    const s = await service(c);
    if (!s) return c.json({ error: { code: "DB_UNAVAILABLE", message: "Base de données indisponible" } }, 503);
    try {
      return await fn(c, s);
    } catch (e) {
      if (e instanceof ClosingError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, errorStatus(e.code));
      throw e;
    }
  };

  const invalid = (c: Context, issues: unknown) => c.json({ error: { code: "VALIDATION", message: "Entrée invalide", details: issues } }, 400);

  // ----- Listes de contrôle -----
  const ChecklistQuery = z.object({ fiscalYear: z.string().min(1), period: z.string().uuid().optional() });

  r.get(
    "/checklist",
    guard(async (c, s) => {
      const q = ChecklistQuery.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      return c.json(await s.listChecklist({ fiscalYearCode: q.data.fiscalYear, ...(q.data.period ? { periodId: q.data.period } : {}) }));
    }),
  );

  /** Génère (idempotent) la liste mensuelle (period) ou annuelle. */
  r.post(
    "/checklist",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER"),
    guard(async (c, s) => {
      const q = ChecklistQuery.safeParse(await c.req.json());
      if (!q.success) return invalid(c, q.error.issues);
      return c.json(await s.generateChecklist({ fiscalYearCode: q.data.fiscalYear, ...(q.data.period ? { periodId: q.data.period } : {}) }), 201);
    }),
  );

  r.post(
    "/checklist/:id/tick",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER"),
    guard(async (c, s) => {
      const body = z.object({ status: z.enum(["TODO", "DONE", "NA"]).default("DONE"), evidence: z.record(z.unknown()).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
      if (!body.success) return invalid(c, body.error.issues);
      return c.json(await s.tick(c.req.param("id")!, { status: body.data.status, ...(body.data.evidence ? { evidence: body.data.evidence } : {}) }));
    }),
  );

  // ----- Périodes -----
  r.get(
    "/periods",
    guard(async (c, s) => {
      const q = z.object({ fiscalYear: z.string().min(1) }).safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      return c.json(await s.periods(q.data.fiscalYear));
    }),
  );

  r.post(
    "/periods/:id/close",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER"),
    guard(async (c, s) => c.json(await s.closePeriod(c.req.param("id")!))),
  );

  /** Déverrouillage : commentaire + approbateur distinct (REVIEWER/OWNER) ; trace period.unlock. */
  r.post(
    "/periods/:id/unlock",
    requireRole("OWNER", "REVIEWER"),
    guard(async (c, s) => {
      const body = z.object({ comment: z.string().min(5).max(2000), approverId: z.string().uuid() }).safeParse(await c.req.json());
      if (!body.success) return invalid(c, body.error.issues);
      return c.json(await s.unlockPeriod(c.req.param("id")!, body.data));
    }),
  );

  // ----- Workflow de l'exercice -----
  r.get(
    "/fiscal-years/:code/workflow",
    guard(async (c, s) => c.json(await s.getWorkflow(c.req.param("code")!))),
  );

  r.post(
    "/fiscal-years/:code/workflow",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER"),
    guard(async (c, s) => {
      const body = z.object({ to: z.enum(WORKFLOW_STATES), comment: z.string().max(2000).optional(), filingReceiptDocumentId: z.string().uuid().optional() }).safeParse(await c.req.json());
      if (!body.success) return invalid(c, body.error.issues);
      const { to, comment, filingReceiptDocumentId } = body.data;
      return c.json(await s.transition(c.req.param("code")!, to, { ...(comment ? { comment } : {}), ...(filingReceiptDocumentId ? { filingReceiptDocumentId } : {}) }));
    }),
  );

  r.get(
    "/fiscal-years/:code/controls",
    guard(async (c, s) => c.json(await s.failedBlockingControls(c.req.param("code")!))),
  );

  r.post(
    "/fiscal-years/:code/lock",
    requireRole("OWNER", "REVIEWER"),
    guard(async (c, s) => c.json(await s.lockFiscalYear(c.req.param("code")!))),
  );

  return r;
}
