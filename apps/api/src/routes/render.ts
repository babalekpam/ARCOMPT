// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { computeStatements } from "@arcompt/statements";
import { withTenant, decryptTaxIds, existingTenantCipherIn } from "@arcompt/db";
import {
  ledgerViewFromEntries,
  ledgerWorkbook,
  renderHtml,
  renderPdf,
  resolveLocale,
  statementsWorkbook,
  trialBalanceView,
  trialBalanceWorkbook,
  type CompanyHeader,
  type RenderOptions,
} from "@arcompt/render";
import type { AppDeps } from "../app.js";
import type { AuthContext } from "../auth.js";

/**
 * Dépendances du module de rendu : celles de l'application, plus une fabrique
 * facultative d'en-tête d'entreprise (nom, identifiants fiscaux) pour le
 * dossier courant. Sans elle, l'en-tête n'affiche que l'identifiant du dossier.
 */
export interface RenderDeps extends AppDeps {
  companyFor?: (auth: AuthContext) => Promise<CompanyHeader | null> | CompanyHeader | null;
}

const PDF = "application/pdf";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const baseQuery = z.object({
  fiscalYear: z.string().min(1),
  // Pas de `.default("fr")` : une valeur par défaut posée ici écraserait la
  // langue du dossier, qui est justement celle sous laquelle il est archivé.
  // Absente, `resolveLocale` descend la précédence (docs : packages/render/src/locale.ts).
  locale: z.enum(["fr", "en"]).optional(),
  currency: z.string().length(3).default("XOF"),
});

const statementsQuery = baseQuery.extend({
  previousFiscalYear: z.string().optional(),
  system: z.enum(["NORMAL", "SMT"]).default("NORMAL"),
  templateVersion: z.string().optional(),
});

const ledgerQuery = baseQuery.extend({ account: z.string().optional() });

/**
 * Exports PDF et Excel : états financiers, balance générale, grand livre.
 * Chaque route relit le grand livre via `deps.ledgerFor(auth)` puis délègue
 * au paquet de rendu ; aucune écriture.
 */
export function renderRoutes(deps: RenderDeps) {
  const r = new Hono();

  /**
   * En-tête du dossier, lu en base une fois par requête. Sans ces lignes, tous
   * les exports portaient « Dossier <uuid> » en en-tête — un identifiant
   * technique sur un document destiné au greffe.
   *
   * La langue du dossier est lue ici aussi : ces documents (balance, grand
   * livre, liasse) n'ont pas de destinataire, c'est donc le dossier qui décide,
   * sauf demande explicite.
   */
  const companyOf = async (auth: AuthContext): Promise<{ header: CompanyHeader; locale: string | null }> => {
    const provided = await deps.companyFor?.(auth);
    if (provided) return { header: provided, locale: null };
    if (!deps.db) return { header: { name: `Dossier ${auth.tenantId}` }, locale: null };
    const row = await withTenant(deps.db, { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) }, async (tx) => {
      const [company] = await tx<Array<Record<string, unknown>>>`
        SELECT name, country_code, currency, locale, tax_ids, tax_ids_enc FROM company WHERE id = ${auth.tenantId}`;
      if (!company) return null;
      const cipher = await existingTenantCipherIn(tx, auth.tenantId);
      return { company, taxIds: decryptTaxIds(cipher, company.tax_ids_enc as string | null, company.tax_ids as Record<string, string>) };
    });
    if (!row) return { header: { name: `Dossier ${auth.tenantId}` }, locale: null };
    const identifiers = Object.entries(row.taxIds).map(([label, value]) => ({ label: label.toUpperCase(), value: String(value) }));
    return {
      header: {
        name: String(row.company.name),
        country: String(row.company.country_code),
        ...(identifiers.length > 0 ? { identifiers } : {}),
      },
      locale: row.company.locale as string,
    };
  };

  const options = async (auth: AuthContext, requested: "fr" | "en" | undefined): Promise<RenderOptions> => {
    const { header, locale } = await companyOf(auth);
    return { locale: resolveLocale({ requested, company: locale, user: auth.locale }), company: header };
  };

  const statements = async (c: Context) => {
    const auth = c.get("auth");
    const q = statementsQuery.safeParse(c.req.query());
    if (!q.success) return validation(c, q.error.issues);
    const ledger = deps.ledgerFor(auth);
    const current = await ledger.trialBalance(auth.tenantId, { fiscalYearCode: q.data.fiscalYear });
    const previous = q.data.previousFiscalYear ? await ledger.trialBalance(auth.tenantId, { fiscalYearCode: q.data.previousFiscalYear }) : null;
    const out = computeStatements({
      system: q.data.system,
      currency: q.data.currency,
      fiscalYearCode: q.data.fiscalYear,
      balance: current.rows,
      ...(previous ? { previousBalance: previous.rows } : {}),
      ...(q.data.templateVersion ? { templateVersion: q.data.templateVersion } : {}),
    });
    return { out, opts: await options(auth, q.data.locale), name: `etats-financiers-${q.data.fiscalYear}` };
  };

  r.get("/statements.pdf", async (c) => {
    const res = await statements(c);
    if (res instanceof Response) return res;
    const pdf = await renderPdf(renderHtml("statements", res.out, res.opts));
    return file(c, pdf, PDF, `${res.name}.pdf`);
  });

  r.get("/statements.xlsx", async (c) => {
    const res = await statements(c);
    if (res instanceof Response) return res;
    return file(c, await statementsWorkbook(res.out, res.opts), XLSX, `${res.name}.xlsx`);
  });

  const trialBalance = async (c: Context) => {
    const auth = c.get("auth");
    const q = baseQuery.safeParse(c.req.query());
    if (!q.success) return validation(c, q.error.issues);
    const tb = await deps.ledgerFor(auth).trialBalance(auth.tenantId, { fiscalYearCode: q.data.fiscalYear });
    return { view: trialBalanceView(tb, q.data.currency), opts: await options(auth, q.data.locale), name: `balance-${q.data.fiscalYear}` };
  };

  r.get("/trial-balance.pdf", async (c) => {
    const res = await trialBalance(c);
    if (res instanceof Response) return res;
    return file(c, await renderPdf(renderHtml("trial-balance", res.view, res.opts)), PDF, `${res.name}.pdf`);
  });

  r.get("/trial-balance.xlsx", async (c) => {
    const res = await trialBalance(c);
    if (res instanceof Response) return res;
    return file(c, await trialBalanceWorkbook(res.view, res.opts), XLSX, `${res.name}.xlsx`);
  });

  const ledgerView = async (c: Context) => {
    const auth = c.get("auth");
    const q = ledgerQuery.safeParse(c.req.query());
    if (!q.success) return validation(c, q.error.issues);
    const ledger = deps.ledgerFor(auth);
    // La balance fournit les bornes de l'exercice et les intitulés des comptes mouvementés.
    const tb = await ledger.trialBalance(auth.tenantId, { fiscalYearCode: q.data.fiscalYear });
    const entries = await ledger.listEntries(auth.tenantId, { fiscalYearCode: q.data.fiscalYear, ...(q.data.account ? { accountNumber: q.data.account } : {}) });
    const view = ledgerViewFromEntries(entries, {
      fiscalYearCode: tb.fiscalYearCode,
      from: tb.from,
      to: tb.to,
      currency: q.data.currency,
      accountLabels: new Map(tb.rows.map((row) => [row.accountNumber, row.label])),
      ...(q.data.account ? { accountNumber: q.data.account } : {}),
    });
    return { view, opts: await options(auth, q.data.locale), name: `grand-livre-${q.data.fiscalYear}${q.data.account ? `-${q.data.account}` : ""}` };
  };

  r.get("/ledger.pdf", async (c) => {
    const res = await ledgerView(c);
    if (res instanceof Response) return res;
    return file(c, await renderPdf(renderHtml("ledger", res.view, res.opts)), PDF, `${res.name}.pdf`);
  });

  r.get("/ledger.xlsx", async (c) => {
    const res = await ledgerView(c);
    if (res instanceof Response) return res;
    return file(c, await ledgerWorkbook(res.view, res.opts), XLSX, `${res.name}.xlsx`);
  });

  return r;
}

function validation(c: Context, issues: unknown) {
  return c.json({ error: { code: "VALIDATION", message: "fiscalYear requis", details: issues } }, 400);
}

function file(c: Context, data: Buffer, contentType: string, filename: string) {
  return c.body(new Uint8Array(data), 200, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
}
