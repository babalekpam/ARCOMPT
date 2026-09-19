import { Hono } from "hono";
import { z } from "zod";
import { withTenant } from "@arcompt/db";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

/**
 * Tiers du dossier courant (clients, fournisseurs, salariés, État, autres).
 * Lecture et création directes sur la table `partner` sous RLS (withTenant) :
 * la facturation ne résout un `partnerId` que par cet identifiant. Sans
 * connexion PostgreSQL (tests en mémoire), la liste est vide et la création
 * répond 503.
 *
 * Monté par l'application sous /v1/partners.
 */
export type PartnerType = "CUSTOMER" | "SUPPLIER" | "EMPLOYEE" | "STATE" | "OTHER";

export interface PartnerRow {
  id: string;
  type: PartnerType;
  name: string;
  taxId: string | null;
  collectiveAccount: string;
  contact: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}

const PARTNER_TYPES = ["CUSTOMER", "SUPPLIER", "EMPLOYEE", "STATE", "OTHER"] as const;

/** Compte collectif par défaut selon le type (SYSCOHADA : 401 fournisseurs, 411 clients, 421 personnel, 44 État, 47 autres). */
export const DEFAULT_COLLECTIVE: Record<PartnerType, string> = { CUSTOMER: "411", SUPPLIER: "401", EMPLOYEE: "421", STATE: "441", OTHER: "471" };

const ContactSchema = z
  .object({
    email: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
    address: z.string().max(500).optional(),
    city: z.string().max(120).optional(),
    country: z.string().max(2).optional(),
  })
  .passthrough();

const PartnerSchema = z.object({
  type: z.enum(PARTNER_TYPES),
  name: z.string().min(1).max(200),
  taxId: z.string().max(60).optional(),
  collectiveAccount: z.string().regex(/^4\d{1,12}$/).optional(),
  contact: ContactSchema.optional(),
  active: z.boolean().optional(),
});

const ListSchema = z.object({
  type: z.enum(PARTNER_TYPES).optional(),
  q: z.string().max(100).optional(),
  includeInactive: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function toRow(r: Record<string, unknown>): PartnerRow {
  return {
    id: String(r.id),
    type: r.type as PartnerType,
    name: String(r.name),
    taxId: (r.tax_id as string | null) ?? null,
    collectiveAccount: String(r.collective_account),
    contact: (r.contact as Record<string, unknown>) ?? {},
    active: Boolean(r.active),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export function partnersRoutes(deps: AppDeps) {
  const r = new Hono();
  const write = requireRole("OWNER", "ACCOUNTANT", "CASHIER");
  const ctxOf = (auth: { tenantId: string; userId: string; organizationId?: string }) => ({ tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) });

  r.get("/", async (c) => {
    const auth = c.get("auth");
    const q = ListSchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "Paramètres invalides", details: q.error.issues } }, 400);
    if (!deps.db) return c.json({ partners: [] as PartnerRow[] });
    const { type, q: search, includeInactive, limit } = q.data;
    const pattern = search ? `%${search.replace(/[%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await withTenant(deps.db, ctxOf(auth), (tx) =>
      tx<Record<string, unknown>[]>`
        SELECT id, type, name, tax_id, collective_account, contact, active, created_at
        FROM partner
        WHERE tenant_id = ${auth.tenantId}
          ${includeInactive === "true" ? tx`` : tx`AND active = true`}
          ${type ? tx`AND type = ${type}` : tx``}
          ${pattern ? tx`AND (name ILIKE ${pattern} OR tax_id ILIKE ${pattern})` : tx``}
        ORDER BY name
        LIMIT ${limit ?? 100}`,
    );
    return c.json({ partners: rows.map(toRow) });
  });

  r.get("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: { code: "VALIDATION", message: "Identifiant invalide" } }, 400);
    if (!deps.db) return c.json({ error: { code: "NOT_FOUND", message: "Tiers introuvable" } }, 404);
    const [row] = await withTenant(deps.db, ctxOf(auth), (tx) => tx<Record<string, unknown>[]>`SELECT id, type, name, tax_id, collective_account, contact, active, created_at FROM partner WHERE tenant_id = ${auth.tenantId} AND id = ${id}`);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Tiers introuvable" } }, 404);
    return c.json(toRow(row));
  });

  r.post("/", write, async (c) => {
    const auth = c.get("auth");
    const parsed = PartnerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Tiers indisponibles sans base de données" } }, 503);
    const input = parsed.data;
    const collective = input.collectiveAccount ?? DEFAULT_COLLECTIVE[input.type];
    const contact = JSON.stringify(input.contact ?? {});
    const [row] = await withTenant(deps.db, ctxOf(auth), (tx) =>
      tx<Record<string, unknown>[]>`
        INSERT INTO partner (tenant_id, type, name, tax_id, collective_account, contact, active)
        VALUES (${auth.tenantId}, ${input.type}, ${input.name.trim()}, ${input.taxId?.trim() || null}, ${collective}, ${contact}::jsonb, ${input.active ?? true})
        RETURNING id, type, name, tax_id, collective_account, contact, active, created_at`,
    );
    return c.json(toRow(row!), 201);
  });

  r.put("/:id", write, async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: { code: "VALIDATION", message: "Identifiant invalide" } }, 400);
    const parsed = PartnerSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Tiers indisponibles sans base de données" } }, 503);
    const p = parsed.data;
    const [row] = await withTenant(deps.db, ctxOf(auth), (tx) =>
      tx<Record<string, unknown>[]>`
        UPDATE partner SET
          type = COALESCE(${p.type ?? null}, type),
          name = COALESCE(${p.name?.trim() ?? null}, name),
          tax_id = ${p.taxId === undefined ? tx`tax_id` : tx`${p.taxId.trim() || null}`},
          collective_account = COALESCE(${p.collectiveAccount ?? null}, collective_account),
          contact = ${p.contact === undefined ? tx`contact` : tx`${JSON.stringify(p.contact)}::jsonb`},
          active = COALESCE(${p.active ?? null}, active)
        WHERE tenant_id = ${auth.tenantId} AND id = ${id}
        RETURNING id, type, name, tax_id, collective_account, contact, active, created_at`,
    );
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Tiers introuvable" } }, 404);
    return c.json(toRow(row));
  });

  return r;
}
