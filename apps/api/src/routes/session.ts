import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadPack } from "@arcompt/country-packs";
import { resolveChart } from "@arcompt/db";
import { DEFAULT_JOURNALS } from "@arcompt/ledger";
import type { AppDeps } from "../app.js";
import type { AuthContext } from "../auth.js";

const BootstrapSchema = z.object({
  name: z.string().min(1).max(200),
  countryCode: z.enum(["BF", "BJ", "CI", "CM", "ML", "NE", "SN", "TG"]),
  packCode: z.enum(["bf", "bj", "ci", "cm", "ml", "ne", "sn", "tg"]),
  fiscalYear: z.object({
    code: z.string().min(1).max(20),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).refine((v) => {
    const start = new Date(`${v.startDate}T00:00:00Z`);
    const end = new Date(`${v.endDate}T00:00:00Z`);
    return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) &&
      start.toISOString().slice(0, 10) === v.startDate &&
      end.toISOString().slice(0, 10) === v.endDate && end > start;
  }, "Dates fiscales invalides"),
});

/** Tenantless, POST-only first-login provisioning. Invitation acceptance is separate. */
export function sessionRoutes(deps: AppDeps) {
  const r = new Hono();
  r.post("/session/bootstrap", async (c) => {
    const auth = c.get("auth") as AuthContext;
    if (auth.platformAdmin || !auth.clerkSub || !auth.clerkEmail) {
      return c.json({ error: { code: "BOOTSTRAP_NOT_ALLOWED", message: "Ce compte ne peut pas créer un nouveau dossier" } }, 403);
    }
    const parsed = BootstrapSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 422);
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Base de données non configurée" } }, 503);
    const input = parsed.data;
    let pack;
    try { pack = loadPack(input.packCode ?? input.countryCode.toLowerCase()); }
    catch { return c.json({ error: { code: "PACK_INVALID", message: "Pack pays inconnu" } }, 422); }
    if (pack.code !== input.countryCode.toLowerCase()) {
      return c.json({ error: { code: "PACK_INVALID", message: "Le pack ne correspond pas au pays" } }, 422);
    }
    const system = "NORMAL" as const;
    if (!pack.identity.accounting_systems.includes(system)) {
      return c.json({ error: { code: "VALIDATION", message: `Système ${system} non prévu par le pack ${pack.code}` } }, 422);
    }
    try {
      const result = await deps.db.begin(async (tx) => {
        const sql = tx as unknown as typeof deps.db;
        await sql`select set_config('app.tenant_id', '', true), set_config('app.organization_id', '', true), set_config('app.user_id', '', true), set_config('app.clerk_sub', ${auth.clerkSub!}, true)`;
        await sql`select pg_advisory_xact_lock(hashtext(lower(${auth.clerkEmail!})))`;
        const [replay] = await sql`SELECT company_id FROM onboarding_bootstrap WHERE clerk_sub = ${auth.clerkSub!}`;
        if (replay) return { companyId: String(replay.company_id), replay: true };
        const [eligibility] = await sql`SELECT state, company_id FROM auth_bootstrap_lookup(${auth.clerkSub!}, ${auth.clerkEmail!})`;
        if (eligibility?.state === "REPLAY") return { companyId: String(eligibility.company_id), replay: true };
        if (eligibility?.state !== "ELIGIBLE") throw new BootstrapError("ALREADY_LINKED", "Une identité ou adresse est déjà rattachée à un compte");
        const orgId = randomUUID();
        const userId = randomUUID();
        const companyId = randomUUID();
        await sql`select set_config('app.organization_id', ${orgId}, true)`;
        await sql`INSERT INTO organization (id, name, kind, plan) VALUES (${orgId}, ${input.name}, 'COMPANY', 'TRIAL')`;
        await sql`INSERT INTO organization_subscription (organization_id, plan_code, started_at, ended_at) VALUES (${orgId}, 'TRIAL', current_date, current_date + 14)`;
        await sql`INSERT INTO app_user (id, organization_id, keycloak_sub, email, display_name) VALUES (${userId}, ${orgId}, ${auth.clerkSub!}, ${auth.clerkEmail!}, ${auth.clerkDisplayName ?? auth.clerkEmail!})`;
        await sql`INSERT INTO company (id, organization_id, name, country_code, currency, accounting_system, pack_version) VALUES (${companyId}, ${orgId}, ${input.name}, ${input.countryCode}, ${pack.identity.currency}, ${system}, ${pack.code + "@" + pack.version})`;
        await sql`select set_config('app.tenant_id', ${companyId}, true), set_config('app.organization_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
        for (const a of resolveChart()) await sql`INSERT INTO account (tenant_id, number, label, class, nature, lettrable, postable) VALUES (${companyId}, ${a.number}, ${a.label}, ${a.class}, ${a.nature}, ${a.lettrable}, ${a.postable})`;
        for (const o of pack.chart_overrides) {
          const cls = Number(o.number[0]);
          await sql`INSERT INTO account (tenant_id, number, label, class, nature, lettrable, postable)
            VALUES (${companyId}, ${o.number}, ${o.label}, ${cls}, ${natureOfClass(cls)}, ${o.lettrable ?? false}, true)
            ON CONFLICT (tenant_id, number) DO UPDATE SET label = EXCLUDED.label, lettrable = EXCLUDED.lettrable`;
          await sql`UPDATE account SET postable = false WHERE tenant_id = ${companyId} AND number <> ${o.number} AND ${o.number} LIKE number || '%'`;
        }
        for (const j of DEFAULT_JOURNALS) await sql`INSERT INTO journal (tenant_id, code, label, type) VALUES (${companyId}, ${j.code}, ${j.label}, ${j.type})`;
        const [fy] = await sql`INSERT INTO fiscal_year (tenant_id, code, start_date, end_date) VALUES (${companyId}, ${input.fiscalYear.code}, ${input.fiscalYear.startDate}, ${input.fiscalYear.endDate}) RETURNING id`;
        await sql`INSERT INTO period (tenant_id, fiscal_year_id, start_date, end_date)
          SELECT ${companyId}, ${String(fy!.id)}, greatest(gs::date, ${input.fiscalYear.startDate}::date),
                 least((gs + interval '1 month - 1 day')::date, ${input.fiscalYear.endDate}::date)
          FROM generate_series(date_trunc('month', ${input.fiscalYear.startDate}::date), ${input.fiscalYear.endDate}::date, interval '1 month') gs`;
        await sql`INSERT INTO company_member (company_id, user_id, role) VALUES (${companyId}, ${userId}, 'OWNER')`;
        await sql`INSERT INTO onboarding_bootstrap (clerk_sub, company_id) VALUES (${auth.clerkSub!}, ${companyId})`;
        return { companyId, replay: false };
      });
      return c.json({ companyId: result.companyId }, result.replay ? 200 : 201);
    } catch (e) {
      if (e instanceof BootstrapError) return c.json({ error: { code: e.code, message: e.message } }, 409);
      throw e;
    }
  });
  return r;
}

class BootstrapError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function natureOfClass(cls: number): string {
  if (cls === 1) return "PASSIF";
  if ([2, 3, 5].includes(cls)) return "ACTIF";
  if ([4, 8].includes(cls)) return "MIXTE";
  if (cls === 6) return "CHARGE";
  if (cls === 7) return "PRODUIT";
  return "ENGAGEMENT";
}