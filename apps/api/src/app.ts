import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Sql } from "postgres";
import { LedgerError, type Ledger } from "@arcompt/ledger";
import { authMiddleware, type AuthOptions } from "./auth.js";
import { entriesRoutes } from "./routes/entries.js";
import { statementsRoutes } from "./routes/statements.js";
import { packsRoutes } from "./routes/packs.js";

export interface AppDeps {
  /** Fabrique un moteur comptable pour le contexte courant (adaptateur mémoire ou PostgreSQL). */
  ledgerFor: (ctx: { userId: string; tenantId: string; organizationId?: string }) => Ledger;
  /** Connexion PostgreSQL (absente dans les tests API en mémoire) ; les modules l'utilisent via withTenant(). */
  db?: Sql;
  auth: AuthOptions;
  quiet?: boolean;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  if (!deps.quiet) app.use(logger());

  app.get("/health", (c) => c.json({ ok: true, service: "arcompt-api" }));

  const api = new Hono();
  api.use("*", authMiddleware(deps.auth));
  api.route("/entries", entriesRoutes(deps));
  api.route("/statements", statementsRoutes(deps));
  api.route("/packs", packsRoutes());
  app.route("/v1", api);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof LedgerError) {
      const status = err.code === "ENTRY_NOT_FOUND" ? 404 : err.code === "PERIOD_LOCKED" || err.code === "ENTRY_IMMUTABLE" || err.code === "ALREADY_REVERSED" ? 409 : 422;
      return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, status);
    }
    if (!deps.quiet) console.error(err);
    return c.json({ error: { code: "INTERNAL", message: "Erreur interne" } }, 500);
  });
  return app;
}
