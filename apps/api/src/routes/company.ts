import { Hono } from "hono";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { createStorageFromEnv } from "@arcompt/storage";

export type CompanyRouteDeps = { db?: Sql };
const MAX_LOGO = 2 * 1024 * 1024;
const OK_MIME = new Set(["image/png","image/jpeg","image/webp","image/gif"]);
function tid(c:any){ const a=c.get("auth"); return a?.tenantId as string; }
export function companyRoutes(deps: CompanyRouteDeps) {
  const app = new Hono();
  app.get("/profile", async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const rows = await withTenant(deps.db, { tenantId: t }, async (tx:any) => tx`select id, name, country_code, currency, address, city, phone, logo_key, logo_mime from company where id = ${t} limit 1`);
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
    await withTenant(deps.db, { tenantId: t }, async (tx:any) => {
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
    await withTenant(deps.db, { tenantId: t }, async (tx:any) => tx`update company set logo_key = ${key}, logo_mime = ${mime} where id = ${t}`);
    return c.json({ ok: true, logoDataUri: "data:" + mime + ";base64," + Buffer.from(buf).toString("base64") });
  });
  app.delete("/logo", async (c) => {
    if (!deps.db) return c.json({ error: "indisponible" }, 503);
    const t = tid(c); if (!t) return c.json({ error: "non connecte" }, 401);
    const rows = await withTenant(deps.db, { tenantId: t }, async (tx:any) => tx`select logo_key from company where id = ${t} limit 1`);
    const r:any = (rows as any[])[0];
    if (r?.logo_key) { try { const s = createStorageFromEnv(); await s.delete(r.logo_key); } catch {} }
    await withTenant(deps.db, { tenantId: t }, async (tx:any) => tx`update company set logo_key = null, logo_mime = null where id = ${t}`);
    return c.json({ ok: true });
  });
  return app;
}
