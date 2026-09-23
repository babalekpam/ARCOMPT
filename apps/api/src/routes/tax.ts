// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { decryptTaxIds, existingTenantCipherIn, withTenant } from "@arcompt/db";
import { loadPack, PackError, type CountryPack } from "@arcompt/country-packs";
import { TaxError, TaxService } from "@arcompt/tax";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^-?\d+(\.\d{1,4})?$/);

function errorStatus(code: TaxError["code"]): 404 | 409 | 422 {
  if (code === "NOT_FOUND") return 404;
  // Pack non publié : l'état du pack s'oppose à la demande, pas sa forme.
  if (code === "INVALID_STATE" || code === "PACK_NOT_PUBLISHED") return 409;
  return 422;
}

const packCache = new Map<string, CountryPack | null>();
function packFor(countryCode: string): CountryPack | null {
  const code = countryCode.toLowerCase();
  if (!packCache.has(code)) {
    try {
      packCache.set(code, loadPack(code));
    } catch (e) {
      if (!(e instanceof PackError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      packCache.set(code, null);
    }
  }
  return packCache.get(code) ?? null;
}

export function taxRoutes(deps: AppDeps) {
  const r = new Hono();

  const service = async (c: Context): Promise<TaxService | null> => {
    if (!deps.db) return null;
    const auth = c.get("auth");
    const loaded = await withTenant(deps.db, auth, async (tx) => {
      const [row] = await tx`SELECT name, currency, country_code, accounting_system, tax_ids, tax_ids_enc FROM company WHERE id = ${auth.tenantId}`;
      if (!row) return null;
      const cipher = row.tax_ids_enc ? await existingTenantCipherIn(tx, auth.tenantId) : null;
      return { row, taxIds: decryptTaxIds(cipher, row.tax_ids_enc as string | null, row.tax_ids as Record<string, unknown> | null) };
    });
    const company = loaded?.row;
    const pack = company ? packFor(company.country_code as string) : null;
    return new TaxService({
      db: deps.db,
      ledger: deps.ledgerFor(auth),
      ctx: auth,
      currency: (company?.currency as string | undefined) ?? "XOF",
      system: (company?.accounting_system as "NORMAL" | "SMT" | undefined) ?? "NORMAL",
      ...(pack ? { pack } : {}),
      ...(company ? { company: { name: company.name as string, taxIds: loaded!.taxIds } } : {}),
    });
  };

  const guard = (fn: (c: Context, s: TaxService) => Promise<Response>) => async (c: Context) => {
    const s = await service(c);
    if (!s) return c.json({ error: { code: "DB_UNAVAILABLE", message: "Base de données indisponible" } }, 503);
    try {
      return await fn(c, s);
    } catch (e) {
      if (e instanceof TaxError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, errorStatus(e.code));
      throw e;
    }
  };

  const invalid = (c: Context, issues: unknown) => c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: issues } }, 400);

  // ----- TVA -----
  r.get(
    "/vat/returns",
    guard(async (c, s) => c.json(await s.listReturns("VAT"))),
  );

  r.post(
    "/vat/returns/compute",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const parsed = z.object({ from: isoDate, to: isoDate, previousCredit: money.optional() }).safeParse(await c.req.json());
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const { from, to, previousCredit } = parsed.data;
      return c.json(await s.computeVat({ from, to, ...(previousCredit !== undefined ? { previousCredit } : {}) }), 201);
    }),
  );

  r.get(
    "/vat/returns/:id",
    guard(async (c, s) => c.json(await s.getReturn(c.req.param("id")!))),
  );

  r.post(
    "/vat/returns/:id/validate",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const body = z.object({ date: isoDate.optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
      if (!body.success) return invalid(c, body.error.issues);
      return c.json(await s.validateVat(c.req.param("id")!, body.data.date ? { date: body.data.date } : {}));
    }),
  );

  r.post(
    "/vat/returns/:id/pay",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const body = z.object({ date: isoDate, treasuryAccount: z.string().regex(/^5\d{1,12}$/).optional() }).safeParse(await c.req.json());
      if (!body.success) return invalid(c, body.error.issues);
      return c.json(await s.payVat(c.req.param("id")!, { date: body.data.date, ...(body.data.treasuryAccount ? { treasuryAccount: body.data.treasuryAccount } : {}) }));
    }),
  );

  r.post(
    "/vat/returns/:id/file",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const body = z.object({ filingReference: z.string().min(1).max(120) }).safeParse(await c.req.json());
      if (!body.success) return invalid(c, body.error.issues);
      return c.json(await s.markFiled(c.req.param("id")!, body.data.filingReference));
    }),
  );

  // ----- IS -----
  r.get(
    "/is/instalments",
    guard(async (c, s) => c.json(await s.listReturns("IS_INSTALMENT"))),
  );

  r.post(
    "/is/instalments",
    requireRole("OWNER", "ACCOUNTANT"),
    guard(async (c, s) => {
      const parsed = z.object({ fiscalYear: z.string().min(1), fiscalResult: money, turnover: money, instalments: z.number().int().min(1).max(12).optional() }).safeParse(await c.req.json());
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const { fiscalYear, instalments, ...rest } = parsed.data;
      return c.json(await s.isInstalments({ fiscalYearCode: fiscalYear, ...rest, ...(instalments !== undefined ? { instalments } : {}) }), 201);
    }),
  );

  // ----- Retenues à la source -----
  r.get(
    "/withholding",
    guard(async (c, s) => {
      const q = z.object({ from: isoDate, to: isoDate }).safeParse(c.req.query());
      if (!q.success) return c.json({ error: { code: "VALIDATION", message: "from et to requis (AAAA-MM-JJ)" } }, 400);
      return c.json(await s.withholdingRegister(q.data.from, q.data.to));
    }),
  );

  // ----- DSF -----
  const DsfQuery = z.object({ reintegrations: money.default("0"), deductions: money.default("0"), previousFiscalYear: z.string().optional() });

  r.get(
    "/dsf/:fiscalYear{.+\\.xlsx}",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "AUDITOR"),
    guard(async (c, s) => {
      const fiscalYear = c.req.param("fiscalYear")!.replace(/\.xlsx$/, "");
      const q = DsfQuery.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const { buffer, dsf } = await s.dsfWorkbook(fiscalYear, { reintegrations: q.data.reintegrations, deductions: q.data.deductions, ...(q.data.previousFiscalYear ? { previousFiscalYearCode: q.data.previousFiscalYear } : {}) });
      // Nom de fichier et en-tête : un classeur produit depuis un pack non
      // publié ne doit pas ressembler au vrai une fois enregistré sur le poste.
      const name = dsf.official ? `dsf-${fiscalYear}.xlsx` : `dsf-${fiscalYear}-NON-OFFICIEL.xlsx`;
      return c.body(new Uint8Array(buffer), 200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${name}"`,
        ...(dsf.official ? {} : { "x-arcompt-official": "false" }),
      });
    }),
  );

  r.get(
    "/dsf/:fiscalYear",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "AUDITOR"),
    guard(async (c, s) => {
      const q = DsfQuery.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const { dsf, taxReturn } = await s.buildDsf(c.req.param("fiscalYear")!, { reintegrations: q.data.reintegrations, deductions: q.data.deductions, ...(q.data.previousFiscalYear ? { previousFiscalYearCode: q.data.previousFiscalYear } : {}) });
      return c.json({ taxReturn, ...dsf });
    }),
  );

  // ----- Calendrier -----
  r.get(
    "/calendar",
    guard(async (c, s) => {
      const q = z.object({ year: z.coerce.number().int().min(2000).max(2100), today: isoDate.optional() }).safeParse(c.req.query());
      if (!q.success) return c.json({ error: { code: "VALIDATION", message: "year requis" } }, 400);
      return c.json(await s.calendar(q.data.year, q.data.today));
    }),
  );

  return r;
}
