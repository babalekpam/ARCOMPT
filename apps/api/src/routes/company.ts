import { Hono } from "hono";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { createStorageFromEnv } from "@arcompt/storage";
import { requireRole } from "../auth.js";

export type CompanyRouteDeps = { db?: Sql };
const MAX_LOGO = 2 * 1024 * 1024;
const OK_MIME = new Set(["image/png","image/jpeg","image/webp","image/gif"]);
/**
 * Tables métier effacées par la réinitialisation, dans l'ordre des
 * dépendances FK (les tables référencées sont vidées après leurs
 * référentes). La structure n'y figure pas : account, journal,
 * fiscal_year, period, treasury_account, company, company_member,
 * audit_log et les référentiels sont conservés.
 */
const RESET_TABLES = [
  "account_balance", "ai_proposal", "asset_depreciation", "bank_transaction",
  "cash_count", "categorization_memory", "company_comment", "dunning",
  "dunning_log", "filing", "fiscal_year_workflow", "missing_document_request",
  "payment_allocation", "payment_link", "payroll_declaration", "payslip",
  "purchase_document_line", "reconciliation_line", "sales_document_line",
  "stock_closing_line", "stock_count_line", "stock_movement", "tax_return",
  "bank_statement", "employee", "fixed_asset", "journal_line", "payment",
  "payroll_run", "purchase_document", "reconciliation", "sales_document",
  "stock_article", "stock_closing", "document", "partner", "product",
  "stock_count", "journal_entry",
] as const;

/** Compteurs présentés avant confirmation dans la Zone sensible. */
const RESET_COUNT_QUERIES = {
  partners: "partner",
  products: "product",
  salesDocuments: "sales_document",
  purchaseDocuments: "purchase_document",
  employees: "employee",
  bankTransactions: "bank_transaction",
  journalEntries: "journal_entry",
  documents: "document",
} as const;

function normalizeName(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
}

function tid(c:any){ const a=c.get("auth"); return a?.tenantId as string; }
function tctx(c:any){ const a=c.get("auth"); return { tenantId: a?.tenantId as string, ...(a?.organizationId ? { organizationId: a.organizationId as string } : {}), ...(a?.userId ? { userId: a.userId as string } : {}) }; }
export function companyRoutes(deps: CompanyRouteDeps) {
  const app = new Hono();
  app.get("/profile", async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const rows = await withTenant(deps.db, tctx(c), async (tx:any) => tx`select id, name, country_code, currency, address, city, phone, logo_key, logo_mime from company where id = ${t} limit 1`);
    const r:any = (rows as any[])[0]; if (!r) return c.json({ error: "introuvable" }, 404);
    let logoDataUri: string | null = null;
    if (r.logo_key && r.logo_mime) { try { const s = createStorageFromEnv(); const b = await s.get(r.logo_key); if (b) logoDataUri = "data:" + r.logo_mime + ";base64," + Buffer.from(b.bytes).toString("base64"); } catch {} }
    return c.json({ profile: { id: r.id, name: r.name, countryCode: r.country_code, currency: r.currency, address: r.address ?? null, city: r.city ?? null, phone: r.phone ?? null, logoDataUri } });
  });
  app.patch("/profile", async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const body:any = await c.req.json().catch(() => ({}));
    const address = typeof body.address === "string" ? body.address.trim().slice(0,500) : "";
    const city = typeof body.city === "string" ? body.city.trim().slice(0,120) : "";
    const phone = typeof body.phone === "string" ? body.phone.trim().slice(0,40) : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0,200) : "";
    await withTenant(deps.db, tctx(c), async (tx:any) => {
      if (name) await tx`update company set address = ${address||null}, city = ${city||null}, phone = ${phone||null}, name = ${name} where id = ${t}`;
      else await tx`update company set address = ${address||null}, city = ${city||null}, phone = ${phone||null} where id = ${t}`;
    });
    return c.json({ ok: true });
  });
  app.post("/logo", async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const form:any = await c.req.parseBody().catch(() => ({}));
    const f:any = form["file"] ?? form["logo"] ?? form[Object.keys(form)[0] ?? ""] ?? form;
    const file = f && typeof f.arrayBuffer === "function" ? f : null;
    if (!file) return c.json({ error: "fichier manquant" }, 400);
    const mime = String(file.type || "");
    if (!OK_MIME.has(mime)) return c.json({ error: "image uniquement (png, jpeg, webp, gif)" }, 400);
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.byteLength > MAX_LOGO) return c.json({ error: "image trop grande (2 Mo max)" }, 400);
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
    const key = "companies/" + t + "/logo." + ext;
    const s = createStorageFromEnv(); await s.put(key, buf, { contentType: mime });
    await withTenant(deps.db, tctx(c), async (tx:any) => tx`update company set logo_key = ${key}, logo_mime = ${mime} where id = ${t}`);
    return c.json({ ok: true, logoDataUri: "data:" + mime + ";base64," + Buffer.from(buf).toString("base64") });
  });
  // --- Réinitialisation du dossier (Zone sensible) -------------------------
  // Supprime les données métier du dossier courant (clients, fournisseurs,
  // produits, documents de vente/achat, paie, trésorerie, écritures) en
  // conservant la structure : plan de comptes, journaux, exercices, profil,
  // membres et abonnement. Réservé au rôle OWNER, confirmation par saisie
  // exacte du nom du dossier, journalisé dans audit_log.
  app.get("/reset-summary", requireRole("OWNER"), async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const summary = await withTenant(deps.db, tctx(c), async (tx: any) => {
      const [company] = await tx`select name from company where id = ${t} limit 1`;
      if (!company) return null;
      const counts: Record<string, number> = {};
      for (const key of Object.keys(RESET_COUNT_QUERIES) as (keyof typeof RESET_COUNT_QUERIES)[]) {
        const [row] = await tx.unsafe(`select count(*)::int as n from ${RESET_COUNT_QUERIES[key]} where tenant_id = $1`, [t]);
        counts[key] = row?.n ?? 0;
      }
      return { companyName: String(company.name), counts };
    });
    if (!summary) return c.json({ error: "introuvable" }, 404);
    return c.json(summary);
  });
  app.post("/reset-data", requireRole("OWNER"), async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const auth = c.get("auth") as any;
    const body: any = await c.req.json().catch(() => ({}));
    const confirmName = typeof body.confirmName === "string" ? body.confirmName : "";
    const result = await withTenant(deps.db, tctx(c), async (tx: any) => {
      const [company] = await tx`select name from company where id = ${t} limit 1`;
      if (!company) return { status: 404 as const, payload: { error: "introuvable" } };
      if (normalizeName(confirmName) !== normalizeName(String(company.name))) {
        return { status: 400 as const, payload: { error: "confirmation incorrecte : saisissez le nom exact du dossier" } };
      }
      const removed: Record<string, number> = {};
      for (const table of RESET_TABLES) {
        const res = await tx.unsafe(`delete from ${table} where tenant_id = $1`, [t]);
        removed[table] = res.count ?? 0;
      }
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after, at)
        VALUES (${t}, ${auth?.userId ?? null}, 'company.reset_data', 'company', ${t}, ${tx.json(removed)}, ${new Date().toISOString()})`;
      return { status: 200 as const, payload: { ok: true, removed } };
    });
    return c.json(result.payload, result.status);
  });
  app.delete("/logo", async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const rows = await withTenant(deps.db, tctx(c), async (tx:any) => tx`select logo_key from company where id = ${t} limit 1`);
    const r:any = (rows as any[])[0];
    if (r?.logo_key) { try { const s = createStorageFromEnv(); await s.delete(r.logo_key); } catch {} }
    await withTenant(deps.db, tctx(c), async (tx:any) => tx`update company set logo_key = null, logo_mime = null where id = ${t}`);
    return c.json({ ok: true });
  });
  return app;
}
