import { Hono, type Context } from "hono";
import { z } from "zod";
import { linkPhone, markPhoneVerified, normalizePhone } from "@arcompt/whatsapp";
import { requireRole } from "../auth.js";
import type { AppDeps } from "../app.js";

/**
 * Liaison d'un numéro WhatsApp au dossier courant, par l'utilisateur
 * authentifié (à monter sous /v1/whatsapp, derrière le middleware tenant) :
 *  - POST /link   { phone } → lie le numéro à l'utilisateur et au dossier du jeton,
 *    et horodate la session authentifiée (les validations WhatsApp l'exigent) ;
 *  - POST /verify { phone } → rafraîchit seulement cet horodatage.
 * Le dossier vient TOUJOURS du jeton, jamais du corps. Sans base : 503.
 */
const PhoneSchema = z.object({
  phone: z
    .string()
    .min(6)
    .max(40)
    .refine((p) => /^\d{8,15}$/.test(normalizePhone(p)), "numéro international attendu (8 à 15 chiffres)"),
});

export function whatsappLinkRoutes(deps: AppDeps) {
  const r = new Hono();

  r.use("*", async (c, next) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Canal WhatsApp indisponible : aucune base de données configurée" } }, 503);
    return next();
  });

  const parse = async (c: Context) => PhoneSchema.safeParse((await c.req.json().catch(() => null)) ?? {});

  r.post("/link", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => {
    const body = await parse(c);
    if (!body.success) return c.json({ error: { code: "VALIDATION", message: "{ phone } attendu (format international)", details: body.error.issues } }, 400);
    const auth = c.get("auth");
    const ctx = { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) };
    const phone = normalizePhone(body.data.phone);
    const { conversationId } = await linkPhone(deps.db!, ctx, phone, { verified: true });
    return c.json({ conversationId, phone, tenantId: auth.tenantId, userId: auth.userId, verified: true }, 201);
  });

  r.post("/verify", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => {
    const body = await parse(c);
    if (!body.success) return c.json({ error: { code: "VALIDATION", message: "{ phone } attendu (format international)", details: body.error.issues } }, 400);
    const auth = c.get("auth");
    const ctx = { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) };
    const phone = normalizePhone(body.data.phone);
    const verified = await markPhoneVerified(deps.db!, ctx, phone);
    if (!verified) return c.json({ error: { code: "NOT_FOUND", message: "Numéro non lié à ce dossier" } }, 404);
    return c.json({ phone, verified: true, verifiedAt: new Date().toISOString() });
  });

  return r;
}
