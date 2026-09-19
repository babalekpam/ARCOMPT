import { Hono, type Context } from "hono";
import { z } from "zod";
import { computeStatements } from "@arcompt/statements";
import {
  ledgerViewFromEntries,
  ledgerWorkbook,
  renderHtml,
  renderPdf,
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
  locale: z.enum(["fr", "en"]).default("fr"),
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

  const options = async (auth: AuthContext, locale: "fr" | "en"): Promise<RenderOptions> => {
    const company = (await deps.companyFor?.(auth)) ?? { name: `Dossier ${auth.tenantId}` };
    return { locale, company };
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
