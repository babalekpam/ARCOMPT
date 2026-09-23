// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono } from "hono";
import { z } from "zod";
import type { JournalEntryInput } from "@arcompt/ledger";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/);

const LineSchema = z.object({
  accountNumber: z.string().regex(/^[1-9]\d{1,12}$/),
  debit: money.optional(),
  credit: money.optional(),
  partnerId: z.string().uuid().optional(),
  label: z.string().max(200).optional(),
  currency: z.string().length(3).optional(),
  rate: z.string().optional(),
  analyticCode: z.string().optional(),
  vatCode: z.string().optional(),
});

export const EntryInputSchema = z.object({
  journalCode: z.string().min(1).max(8),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().max(60).optional(),
  label: z.string().min(1).max(200),
  source: z.enum(["MANUAL", "INVOICE", "PURCHASE", "BANK", "PAYROLL", "TAX", "AI", "IMPORT"]).default("MANUAL"),
  lines: z.array(LineSchema).min(2),
  clientId: z.string().uuid().optional(),
  /** true : brouillon + validation dans la foulée. */
  validate: z.boolean().default(false),
});

export function entriesRoutes(deps: AppDeps) {
  const r = new Hono();

  r.post("/", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => {
    const parsed = EntryInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
    const auth = c.get("auth");
    const ledger = deps.ledgerFor(auth);
    const { validate, ...input } = parsed.data;
    const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
    // strip() retire les clés undefined ; le type zod garde des `| undefined` que JournalEntryInput n'admet pas.
    const entryInput = { ...strip(input), lines: input.lines.map(strip) } as unknown as JournalEntryInput;
    const entry = validate ? await ledger.post(auth, entryInput) : await ledger.createDraft(auth, entryInput);
    return c.json(entry, 201);
  });

  r.post("/:id/validate", requireRole("OWNER", "ACCOUNTANT"), async (c) => {
    const auth = c.get("auth");
    return c.json(await deps.ledgerFor(auth).validate(auth, c.req.param("id")));
  });

  r.post("/:id/reverse", requireRole("OWNER", "ACCOUNTANT"), async (c) => {
    const auth = c.get("auth");
    const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), label: z.string().optional() }).parse((await c.req.json().catch(() => ({}))) ?? {});
    const opts = { ...(body.date ? { date: body.date } : {}), ...(body.label ? { label: body.label } : {}) };
    return c.json(await deps.ledgerFor(auth).reverse(auth, c.req.param("id"), opts));
  });

  r.delete("/:id", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => {
    const auth = c.get("auth");
    await deps.ledgerFor(auth).discardDraft(auth, c.req.param("id"));
    return c.body(null, 204);
  });

  r.get("/", async (c) => {
    const auth = c.get("auth");
    const q = z.object({ fiscalYear: z.string(), account: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "fiscalYear requis" } }, 400);
    const entries = await deps.ledgerFor(auth).listEntries(auth.tenantId, { fiscalYearCode: q.data.fiscalYear, ...(q.data.account ? { accountNumber: q.data.account } : {}) });
    return c.json({ entries: entries.slice(-q.data.limit).reverse() });
  });

  r.get("/fiscal-years", async (c) => {
    const auth = c.get("auth");
    return c.json({ fiscalYears: await deps.ledgerFor(auth).listFiscalYears(auth.tenantId) });
  });

  r.get("/trial-balance", async (c) => {
    const auth = c.get("auth");
    const q = z.object({ fiscalYear: z.string(), from: z.string().optional(), to: z.string().optional() }).safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "fiscalYear requis" } }, 400);
    const tb = await deps.ledgerFor(auth).trialBalance(auth.tenantId, { fiscalYearCode: q.data.fiscalYear, ...(q.data.from ? { from: q.data.from } : {}), ...(q.data.to ? { to: q.data.to } : {}) });
    return c.json(tb);
  });

  r.get("/chain/:journal", requireRole("OWNER", "ACCOUNTANT", "AUDITOR", "REVIEWER"), async (c) => {
    const auth = c.get("auth");
    return c.json(await deps.ledgerFor(auth).verifyChain(auth.tenantId, c.req.param("journal")));
  });

  return r;
}
