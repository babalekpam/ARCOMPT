// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono } from "hono";
import { createDocumentsInfraFromEnv, createDocumentsServiceFromEnv } from "@arcompt/documents";
import { MockProvider, PgConversationStore, WhatsAppBot, createProviderFromEnv, verifyMetaSignature, type WhatsAppProvider } from "@arcompt/whatsapp";
import type { AppDeps } from "../app.js";
import { ConfigError } from "../config.js";

/**
 * Webhook WhatsApp. À monter SANS le middleware d'authentification tenant
 * (ex. `app.route("/whatsapp", whatsappRoutes(deps))`) : le dossier vient de
 * la résolution du numéro (`whatsapp_resolve_phone`, SECURITY DEFINER), puis
 * tout passe par withTenant.
 *
 * Env : WHATSAPP_API_URL, WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID,
 * WHATSAPP_APP_SECRET (signature HMAC des webhooks ; obligatoire en production).
 */
export interface WhatsAppRouteDeps extends AppDeps {
  whatsapp?: { provider?: WhatsAppProvider; appSecret?: string };
}

let cachedProvider: WhatsAppProvider | null = null;

/** Réinitialise le fournisseur mémorisé (tests). */
export function resetWhatsAppProvider(): void {
  cachedProvider = null;
}

function providerFor(deps: WhatsAppRouteDeps): WhatsAppProvider | null {
  if (deps.whatsapp?.provider) return deps.whatsapp.provider;
  if (!cachedProvider) {
    const real = createProviderFromEnv();
    if (!real) {
      if (process.env.NODE_ENV === "production") return null;
      // Development keeps the local mock, but production never does.
      console.warn("[arcompt] SIMULATION : canal WhatsApp sortant (développement uniquement).");
      cachedProvider = new MockProvider(process.env.WHATSAPP_VERIFY_TOKEN ?? "dev-verify");
    } else {
      cachedProvider = real;
    }
  }
  return cachedProvider;
}

export function whatsappRoutes(deps: WhatsAppRouteDeps) {
  const r = new Hono();
  const appSecret = deps.whatsapp?.appSecret ?? process.env.WHATSAPP_APP_SECRET;
  const token = Boolean(process.env.WHATSAPP_TOKEN?.trim());
  const phoneId = Boolean(process.env.WHATSAPP_PHONE_ID?.trim());
  if (process.env.NODE_ENV === "production" && token !== phoneId) {
    throw new ConfigError(["WHATSAPP_TOKEN et WHATSAPP_PHONE_ID : configuration partielle — les deux variables sont nécessaires pour activer le canal WhatsApp."]);
  }
  if (token && phoneId && !appSecret && process.env.NODE_ENV === "production") {
    throw new Error("WHATSAPP_APP_SECRET est obligatoire en production");
  }
  const unavailable = () => new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "Canal WhatsApp désactivé : fournisseur non configuré" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  // Resolve once at mount time so development announces its mock explicitly;
  // production resolves to null and remains a disabled 503 route.
  providerFor(deps);

  r.get("/webhook", (c) => {
    const provider = providerFor(deps);
    if (!provider) return unavailable();
    const challenge = provider.verifyWebhook(c.req.query());
    if (challenge === null) return c.text("Forbidden", 403);
    return c.text(challenge);
  });

  r.post("/webhook", async (c) => {
    const provider = providerFor(deps);
    if (!provider) return unavailable();
    const raw = await c.req.text();
    if (appSecret && !verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), appSecret)) {
      return c.json({ error: { code: "BAD_SIGNATURE", message: "Signature du webhook invalide" } }, 401);
    }
    if (!deps.db) return c.json({ error: { code: "UNAVAILABLE", message: "Canal WhatsApp indisponible : aucune base de données configurée" } }, 503);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: "VALIDATION", message: "Corps JSON attendu" } }, 400);
    }
    const db = deps.db;
    const infra = createDocumentsInfraFromEnv(db);
    const bot = new WhatsAppBot({
      provider,
      store: new PgConversationStore(db),
      documentsFor: (ctx) => createDocumentsServiceFromEnv(db, ctx),
      gateway: infra.gateway,
      baseCurrency: infra.baseCurrency,
      ...(process.env.WHATSAPP_MAX_AGE_SECONDS ? { maxMessageAgeMs: Number(process.env.WHATSAPP_MAX_AGE_SECONDS) * 1000 } : {}),
      ...(deps.quiet ? {} : { log: (event: string, detail?: unknown) => console.log(`[whatsapp] ${event}`, detail ?? "") }),
    });
    const messages = provider.parseWebhook(body);
    // Meta attend une réponse 200 rapide ; chaque message est traité séquentiellement et ne lève jamais.
    for (const m of messages) await bot.handle(m);
    return c.json({ ok: true, received: messages.length });
  });

  return r;
}
