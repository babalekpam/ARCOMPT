import { Hono } from "hono";
import { z } from "zod";
import {
  decryptTaxId,
  encryptTaxId,
  existingTenantCipherIn,
  PARTNER_TAX_ID_DOMAIN,
  taxIdBlindIndex,
  tenantCipherIn,
  withTenant,
  type TenantCipher,
} from "@arcompt/db";
import { requireRole } from "../auth.js";
import { IdempotencyConflictError, withIdempotency } from "../idempotency.js";
import type { AppDeps } from "../app.js";

/**
 * Tiers du dossier courant (clients, fournisseurs, salariés, État, autres).
 * Lecture et création directes sur la table `partner` sous RLS (withTenant) :
 * la facturation ne résout un `partnerId` que par cet identifiant. Sans
 * connexion PostgreSQL (tests en mémoire), la liste est vide et la création
 * répond 503.
 *
 * **Identifiant fiscal.** `partner.tax_id` est chiffré au repos (AES-256-GCM,
 * clé de données du dossier — docs/SECURITY.md §7). Un chiffré authentifié à IV
 * aléatoire ne se cherche pas au motif : le `tax_id ILIKE '%…%'` d'avant n'a
 * plus de sens. Il est remplacé par un **index aveugle déterministe**
 * (`tax_id_bidx`), qui n'autorise que l'égalité sur la valeur normalisée
 * (majuscules, ponctuation retirée).
 *
 * Conséquence assumée : `?q=` retrouve un tiers par son identifiant **entier**
 * (« CI-1234567-A » comme « ci1234567a »), plus par un fragment. Un
 * NCC/NINEA/IFU se saisit en entier ou se copie-colle ; la recherche par nom,
 * elle, reste une recherche par fragment et ne change pas. L'alternative —
 * supprimer la recherche par identifiant — aurait coûté un usage réel ; le prix
 * de l'index aveugle est qu'il rend observable l'égalité de deux identifiants
 * au sein d'un même dossier, et rien d'autre : sans la clé maître, l'index
 * n'est pas calculable, donc pas testable contre un identifiant candidat.
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
  /**
   * Identifiant de rejeu tiré par l'appareil au moment de la mise en file hors
   * ligne (docs/OFFLINE.md). Deux envois du même brouillon ne créent qu'un tiers.
   */
  clientId: z.string().uuid().optional(),
});

const ListSchema = z.object({
  type: z.enum(PARTNER_TYPES).optional(),
  q: z.string().max(100).optional(),
  includeInactive: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function toRow(r: Record<string, unknown>, cipher: TenantCipher | null): PartnerRow {
  return {
    id: String(r.id),
    type: r.type as PartnerType,
    name: String(r.name),
    // `tax_id` (clair) n'est lu que tant que scripts/encrypt-tax-ids.mts n'est pas passé.
    taxId: decryptTaxId(cipher, r.tax_id_enc as string | null, r.tax_id as string | null),
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
    const { rows, cipher } = await withTenant(deps.db, ctxOf(auth), async (tx) => {
      // Lecture : pas de clé de données créée. Sans clé, le dossier n'a aucun
      // identifiant chiffré — rien à déchiffrer, et l'index aveugle ne
      // retrouverait rien.
      const cipher = await existingTenantCipherIn(tx, auth.tenantId);
      // Nom : recherche par fragment, inchangée. Identifiant fiscal : égalité
      // sur l'index aveugle, la valeur en base étant chiffrée.
      const bidx = search ? taxIdBlindIndex(cipher, PARTNER_TAX_ID_DOMAIN, search) : null;
      const rows = await tx<Record<string, unknown>[]>`
        SELECT id, type, name, tax_id, tax_id_enc, collective_account, contact, active, created_at
        FROM partner
        WHERE tenant_id = ${auth.tenantId}
          ${includeInactive === "true" ? tx`` : tx`AND active = true`}
          ${type ? tx`AND type = ${type}` : tx``}
          ${pattern ? tx`AND (name ILIKE ${pattern}${bidx ? tx` OR tax_id_bidx = ${bidx}` : tx``})` : tx``}
        ORDER BY name
        LIMIT ${limit ?? 100}`;
      return { rows, cipher };
    });
    return c.json({ partners: rows.map((r) => toRow(r, cipher)) });
  });

  r.get("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: { code: "VALIDATION", message: "Identifiant invalide" } }, 400);
    if (!deps.db) return c.json({ error: { code: "NOT_FOUND", message: "Tiers introuvable" } }, 404);
    const found = await withTenant(deps.db, ctxOf(auth), async (tx) => {
      const [row] = await tx<Record<string, unknown>[]>`SELECT id, type, name, tax_id, tax_id_enc, collective_account, contact, active, created_at FROM partner WHERE tenant_id = ${auth.tenantId} AND id = ${id}`;
      return row ? { row, cipher: await existingTenantCipherIn(tx, auth.tenantId) } : null;
    });
    if (!found) return c.json({ error: { code: "NOT_FOUND", message: "Tiers introuvable" } }, 404);
    return c.json(toRow(found.row, found.cipher));
  });

  r.post("/", write, async (c) => {
    const auth = c.get("auth");
    const parsed = PartnerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Tiers indisponibles sans base de données" } }, 503);
    const { clientId, ...input } = parsed.data;
    const collective = input.collectiveAccount ?? DEFAULT_COLLECTIVE[input.type];
    const contact = JSON.stringify(input.contact ?? {});
    // Le tiers et la trace de rejeu s'écrivent dans la MÊME transaction : soit
    // les deux, soit aucun. Un rejeu ne peut donc jamais voir un tiers créé
    // sans sa trace, ni l'inverse.
    let outcome;
    try {
      outcome = await withTenant(deps.db, ctxOf(auth), (tx) =>
        withIdempotency({ tx, tenantId: auth.tenantId, userId: auth.userId, clientId, operation: "partner.create", body: input, resourceKind: "partner" }, async () => {
          // La clé de données du dossier n'est créée que s'il y a réellement un
          // identifiant à chiffrer.
          const cipher = input.taxId?.trim() ? await tenantCipherIn(tx, auth.tenantId) : await existingTenantCipherIn(tx, auth.tenantId);
          const [row] = await tx<Record<string, unknown>[]>`
            INSERT INTO partner (tenant_id, type, name, tax_id_enc, tax_id_bidx, collective_account, contact, active)
            VALUES (${auth.tenantId}, ${input.type}, ${input.name.trim()}, ${encryptTaxId(cipher, input.taxId)},
                    ${taxIdBlindIndex(cipher, PARTNER_TAX_ID_DOMAIN, input.taxId)}, ${collective}, ${contact}::jsonb, ${input.active ?? true})
            RETURNING id, type, name, tax_id, tax_id_enc, collective_account, contact, active, created_at`;
          const body = toRow(row!, cipher);
          return { body, resourceId: body.id };
        }),
      );
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return c.json({ error: { code: "IDEMPOTENCY_CONFLICT", message: e.message } }, 409);
      throw e;
    }
    // Un rejeu répond 200, pas 201 : rien n'a été créé cette fois-ci.
    if (outcome.replayed) c.header("Idempotent-Replay", "true");
    return c.json(outcome.body, outcome.replayed ? 200 : 201);
  });

  r.put("/:id", write, async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: { code: "VALIDATION", message: "Identifiant invalide" } }, 400);
    const parsed = PartnerSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION", message: "Corps invalide", details: parsed.error.issues } }, 400);
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Tiers indisponibles sans base de données" } }, 503);
    const p = parsed.data;
    const updated = await withTenant(deps.db, ctxOf(auth), async (tx) => {
      const cipher = p.taxId?.trim() ? await tenantCipherIn(tx, auth.tenantId) : await existingTenantCipherIn(tx, auth.tenantId);
      // Identifiant non fourni : on laisse les colonnes en place. Fourni : on
      // réécrit le chiffré et son index, et on efface tout reste en clair.
      const [row] = await tx<Record<string, unknown>[]>`
        UPDATE partner SET
          type = COALESCE(${p.type ?? null}, type),
          name = COALESCE(${p.name?.trim() ?? null}, name),
          tax_id = ${p.taxId === undefined ? tx`tax_id` : tx`NULL`},
          tax_id_enc = ${p.taxId === undefined ? tx`tax_id_enc` : tx`${encryptTaxId(cipher, p.taxId)}`},
          tax_id_bidx = ${p.taxId === undefined ? tx`tax_id_bidx` : tx`${taxIdBlindIndex(cipher, PARTNER_TAX_ID_DOMAIN, p.taxId)}`},
          collective_account = COALESCE(${p.collectiveAccount ?? null}, collective_account),
          contact = ${p.contact === undefined ? tx`contact` : tx`${JSON.stringify(p.contact)}::jsonb`},
          active = COALESCE(${p.active ?? null}, active)
        WHERE tenant_id = ${auth.tenantId} AND id = ${id}
        RETURNING id, type, name, tax_id, tax_id_enc, collective_account, contact, active, created_at`;
      return row ? { row, cipher } : null;
    });
    if (!updated) return c.json({ error: { code: "NOT_FOUND", message: "Tiers introuvable" } }, 404);
    return c.json(toRow(updated.row, updated.cipher));
  });

  return r;
}
