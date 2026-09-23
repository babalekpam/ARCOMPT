// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono } from "hono";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { loadPack } from "@arcompt/country-packs";
import { InvoicingError, NullConnector, PaymentsService, type InvoicingDeps } from "@arcompt/invoicing";
import type { AppDeps } from "../app.js";
import { paymentProvidersFromEnv } from "../config.js";
import { raiseSecurityAlert } from "../telemetry.js";

/**
 * Webhooks de paiement mobile money, montés HORS authentification tenant :
 * l'opérateur ne porte pas de jeton. Le dossier est résolu depuis la
 * référence du lien de paiement (`payment_link_resolve`, SECURITY DEFINER),
 * puis la signature HMAC, l'anti-rejeu et l'idempotence sont vérifiés par
 * `PaymentsService.handleWebhook` (SECURITY.md §7.1, engagement n° 8).
 */
export const SYSTEM_USER_ID = "00000000-0000-4000-8000-00000000f00d";

export function publicWebhookRoutes(deps: AppDeps) {
  const r = new Hono();
  // Opérateurs simulés refusés en production (voir config.ts) : le secret de
  // démonstration laissait signer un encaissement à qui devinait la référence.
  const providers = paymentProvidersFromEnv();

  r.post("/payments/:provider/:providerRef", async (c) => {
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Base de données indisponible" } }, 503);
    const provider = c.req.param("provider");
    const providerRef = c.req.param("providerRef");
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const db = deps.db;
    const resolved = await db`SELECT tenant_id FROM payment_link_resolve(${provider}, ${providerRef})`;
    const tenantId = resolved[0]?.tenant_id as string | undefined;
    if (!tenantId) {
      void raiseSecurityAlert({ signal: "webhook.invalid_signature", detail: `lien inconnu ${provider}/${providerRef}` });
      return c.json({ error: { code: "NOT_FOUND", message: "Lien de paiement inconnu" } }, 404);
    }
    const ctx = { tenantId, userId: SYSTEM_USER_ID };
    const [company] = await withTenant(db, ctx, (tx) => tx`SELECT country_code, currency FROM company WHERE id = ${tenantId}`);
    if (!company) return c.json({ error: { code: "NOT_FOUND", message: "Dossier introuvable" } }, 404);
    const sd: InvoicingDeps = {
      db: db as unknown as Sql,
      ledger: deps.ledgerFor(ctx),
      pack: loadPack(String(company.country_code).toLowerCase()),
      currency: String(company.currency),
      certification: new NullConnector(),
      paymentProviders: providers,
    };
    try {
      const outcome = await new PaymentsService(sd, ctx).handleWebhook(provider, rawBody, headers);
      const status = outcome.outcome === "processed" || outcome.outcome === "review" ? 201 : 200;
      if (outcome.outcome === "review") void raiseSecurityAlert({ signal: "payment.entry_divergence", tenantId, detail: `webhook ${provider} ${outcome.eventId}` });
      return c.json(outcome, status);
    } catch (e) {
      if (e instanceof InvoicingError) {
        if (e.code === "INVALID_SIGNATURE" || e.code === "REPLAY") void raiseSecurityAlert({ signal: "webhook.invalid_signature", tenantId, detail: `${provider}: ${e.code}` });
        return c.json({ error: { code: e.code, message: e.message } }, e.httpStatus as 400);
      }
      throw e;
    }
  });
  return r;
}
