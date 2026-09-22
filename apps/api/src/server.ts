import { serve } from "@hono/node-server";
import type { Sql } from "postgres";
import { createDb } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { initTelemetry, log } from "./telemetry.js";

/**
 * La validation passe avant tout le reste : en production elle lève en listant
 * TOUS les problèmes de configuration, donc le processus ne démarre jamais sur
 * un simulateur (extraction IA inventée, antivirus neutre, stockage éphémère,
 * encaissement fictif, certification fiscale fabriquée).
 */
const cfg = loadConfig();
for (const d of cfg.degraded) log("warn", "api.degraded", { detail: d });

await initTelemetry();

const db = createDb();

const app = createApp({
  db: db as unknown as Sql,
  auth: { mode: cfg.auth.mode, ...(cfg.auth.issuer ? { issuer: cfg.auth.issuer } : {}), ...(cfg.auth.audience ? { audience: cfg.auth.audience } : {}) },
  ledgerFor: (ctx) =>
    new Ledger(new PostgresStore(db as unknown as Sql, { userId: ctx.userId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }), {
      baseCurrency: cfg.baseCurrency,
    }),
});

serve({ fetch: app.fetch, port: cfg.port }, () => {
  log("info", "api.started", {
    port: cfg.port,
    auth: cfg.auth.mode,
    storage: cfg.storage.driver,
    antivirus: cfg.antivirus.driver,
    payments: cfg.payments.enabled ? cfg.payments.provider : "désactivé",
    degraded: cfg.degraded.length,
  });
});
