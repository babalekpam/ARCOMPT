import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Sql } from "postgres";
import { LedgerError, type Ledger } from "@arcompt/ledger";
import { authMiddleware, type AuthOptions } from "./auth.js";
import { readinessHandler } from "./health.js";
import { resolveIdentity, touchLastActive, type TokenIdentityHints } from "./identity.js";
import { rateLimit, securityHeaders } from "./security.js";
import { BurstDetector, log, raiseSecurityAlert } from "./telemetry.js";
import { accountsRoutes } from "./routes/accounts.js";
import { anchoringRoutes } from "./routes/anchoring.js";
import { assetsRoutes } from "./routes/assets.js";
import { closingRoutes } from "./routes/closing.js";
import { documentsRoutes } from "./routes/documents.js";
import { entriesRoutes } from "./routes/entries.js";
import { invoicingRoutes } from "./routes/invoicing.js";
import { packsRoutes } from "./routes/packs.js";
import { partnersRoutes } from "./routes/partners.js";
import { payrollRoutes } from "./routes/payroll.js";
import { portalRoutes } from "./routes/portal.js";
import { publicWebhookRoutes } from "./routes/public-webhooks.js";
import { renderRoutes } from "./routes/render.js";
import { statementsRoutes } from "./routes/statements.js";
import { stockRoutes } from "./routes/stock.js";
import { taxRoutes } from "./routes/tax.js";
import { treasuryRoutes } from "./routes/treasury.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { whatsappLinkRoutes } from "./routes/whatsapp-link.js";

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
  app.use("*", securityHeaders());
  // Limitation de débit générale par compte ou IP, plus une limite serrée sur les points coûteux (IA, rendu).
  const authFailures = new BurstDetector(20, 5 * 60_000);
  app.use("/v1/*", rateLimit({ name: "api", limit: 600, windowMs: 60_000, onLimited: (key) => void raiseSecurityAlert({ signal: "rate.limited", detail: key }) }));
  app.use("/v1/documents/*", rateLimit({ name: "ai", limit: 60, windowMs: 60_000, onLimited: (key) => void raiseSecurityAlert({ signal: "ai.call_spike", detail: key }) }));
  app.use("/v1/render/*", rateLimit({ name: "render", limit: 30, windowMs: 60_000 }));

  // Vivacité : aucune dépendance touchée. Un échec ici veut dire « redémarrez
  // le conteneur », pas « la base est tombée » — d'où l'absence de requête SQL.
  app.get("/health", (c) => c.json({ ok: true, service: "arcompt-api" }));

  // Aptitude : aller-retour réel vers PostgreSQL, 503 si une dépendance requise
  // manque ou si l'arrêt en douceur a commencé. Le corps ne dit que l'état par
  // dépendance ; le détail des pannes part dans les journaux.
  const readiness = readinessHandler({
    ...(deps.db ? { db: deps.db } : {}),
    ...(deps.quiet ? {} : { onFailure: (name: string, error: unknown) => log("warn", "ready.dependency_down", { dependency: name, detail: error instanceof Error ? error.message : String(error) }) }),
  });
  app.get("/ready", readiness);
  app.get("/health/ready", readiness); // alias : certaines sondes d'infrastructure préfèrent ce chemin

  const api = new Hono();
  // Autorisation depuis la base : rôles et dossiers viennent de company_member,
  // pas du jeton. Sans connexion PostgreSQL (tests API en mémoire), le mode dev
  // reste seul utilisable.
  const db = deps.db;
  api.use(
    "*",
    authMiddleware({
      ...deps.auth,
      ...(db
        ? {
            resolveIdentity: (sub: string, hints: TokenIdentityHints) => resolveIdentity(db, sub, hints),
            touchLastActive: (userId: string) => touchLastActive(db, userId),
          }
        : {}),
    }),
  );
  api.use("*", async (c, next) => {
    await next();
    if (c.res.status === 401 || c.res.status === 403) {
      const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
      if (authFailures.hit(ip)) void raiseSecurityAlert({ signal: "auth.failure_burst", detail: `ip=${ip}` });
      if (c.res.status === 403) void raiseSecurityAlert({ signal: "rls.rejection", detail: `${c.req.method} ${c.req.path}` });
    }
  });
  api.route("/entries", entriesRoutes(deps));
  api.route("/accounts", accountsRoutes(deps));
  api.route("/partners", partnersRoutes(deps));
  api.route("/whatsapp", whatsappLinkRoutes(deps));
  api.route("/statements", statementsRoutes(deps));
  api.route("/packs", packsRoutes());
  api.route("/render", renderRoutes(deps));
  api.route("/", invoicingRoutes(deps)); // /products, /sales, /purchases, /payments, /receivables, /payables, /dunning
  api.route("/treasury", treasuryRoutes(deps));
  api.route("/payroll", payrollRoutes(deps));
  api.route("/tax", taxRoutes(deps));
  api.route("/assets", assetsRoutes(deps));
  api.route("/stock", stockRoutes(deps)); // /articles, /movements, /positions, /counts, /closings
  api.route("/closing", closingRoutes(deps));
  api.route("/anchors", anchoringRoutes(deps));
  api.route("/", documentsRoutes(deps)); // /documents, /proposals, /assistant, /anomalies
  api.route("/portal", portalRoutes(deps));
  app.route("/v1", api);

  // Canaux entrants sans jeton : WhatsApp (signature Meta) et webhooks de paiement (HMAC + anti-rejeu).
  app.route("/whatsapp", whatsappRoutes(deps));
  app.route("/webhooks", publicWebhookRoutes(deps));

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
