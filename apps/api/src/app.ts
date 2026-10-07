// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Sql } from "postgres";
import { LedgerError, type Ledger } from "@arcompt/ledger";
import { authMiddleware, type AuthOptions } from "./auth.js";
import { requireRole } from "./auth.js";
import { readinessHandler } from "./health.js";
import { checkClamd } from "./clamav-health.js";
import { assertRecentClamAvDatabase } from "@arcompt/documents";
import { recordPlatformAccess, resolveIdentity, resolvePlatformAdmin, resolvePlatformCompanies, resolvePlatformCompany, touchLastActive, type TokenIdentityHints } from "./identity.js";
import { rateLimit, securityHeaders } from "./security.js";
import { BurstDetector, log, raiseSecurityAlert } from "./telemetry.js";
import { accountsRoutes } from "./routes/accounts.js";
import { anchoringRoutes } from "./routes/anchoring.js";
import { assetsRoutes } from "./routes/assets.js";
import { closingRoutes } from "./routes/closing.js";
import { documentsRoutes } from "./routes/documents.js";
import { entriesRoutes } from "./routes/entries.js";
import { companyRoutes } from "./routes/company.js";
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
import { platformRoutes } from "./routes/platform.js";
import { platformAiRoutes } from "./routes/platform-ai.js";
import { sessionRoutes } from "./routes/session.js";
import { mfaRoutes, mfaStatus } from "./mfa.js";
import { adminModeRoutes, resolveAdminMode, modeCompanies, modeAccess, type AdminModeEvidence } from "./admin-mode.js";
import type { JobQueue } from "@arcompt/jobs";
import { withTenant } from "@arcompt/db";

export interface AppDeps {
  jobs?: JobQueue;
  jobStatusSupported?: boolean;
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
    ...(process.env.CLAMAV_HOST ? { probes: [{
      name: "antivirus",
      required: true,
      check: async () => {
        if (process.env.CLAMAV_DATABASE_DIR) await assertRecentClamAvDatabase(process.env.CLAMAV_DATABASE_DIR);
        await checkClamd(process.env.CLAMAV_HOST!, Number(process.env.CLAMAV_PORT || 3310));
      },
    }] } : {}),
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
            resolveAppMfa: (sub: string, sid: string, proof?: string) => mfaStatus(db, sub, sid, proof),
            touchLastActive: (userId: string) => touchLastActive(db, userId),
            resolvePlatformAdmin: (sub: string) => resolvePlatformAdmin(db, sub),
            resolveAdminMode: (sub: string, evidence: AdminModeEvidence) => resolveAdminMode(db, sub, evidence),
            resolvePlatformCompany: async (sub: string, companyId: string, mode?: AdminModeEvidence) => mode
              ? (await modeCompanies(db, sub, mode)).find((company) => company.companyId === companyId) ?? null
              : resolvePlatformCompany(db, sub, companyId),
            resolvePlatformCompanies: (sub: string) => resolvePlatformCompanies(db, sub),
            resolveBootstrapReplay: async (sub: string) => {
              const [row] = await db`SELECT auth_bootstrap_replay(${sub}) AS company_id`;
              return row?.company_id ? String(row.company_id) : null;
            },
            resolveBootstrapEligibility: async (sub: string, email: string) => {
              const [row] = await db`SELECT state FROM auth_bootstrap_lookup(${sub}, ${email})`;
              return row?.state ? String(row.state) : null;
            },
            recordPlatformAccess: (sub: string, companyId: string | null, method: string, path: string, mode?: AdminModeEvidence) => mode
              ? modeAccess(db, sub, mode, companyId, method, path)
              : recordPlatformAccess(db, sub, companyId, method, path),
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
  api.get("/jobs/review-count", requireRole("OWNER", "ACCOUNTANT", "CASHIER"), async (c) => {
    if (!db || !deps.jobStatusSupported) return c.json({ error: { code: "UNAVAILABLE", message: "Statut de la file indisponible" } }, 503);
    const auth = c.get("auth");
    const [row] = await withTenant(db, auth, (tx) => tx`
      SELECT count(*)::integer AS count
      FROM background_job j
      WHERE j.tenant_id = ${auth.tenantId} AND j.name = 'dunning.send' AND j.status = 'FAILED'
        AND NOT EXISTS (
          SELECT 1 FROM background_job_review r
          WHERE r.source_job_id = j.id AND r.tenant_id = j.tenant_id
        )`);
    return c.json({ count: Number(row?.count ?? 0) });
  });
  api.get("/jobs", async (c) => {
    if (!db || !deps.jobStatusSupported) return c.json({ error: { code: "UNAVAILABLE", message: "Statut de la file indisponible" } }, 503);
    const status = c.req.query("status") ?? "FAILED";
    if (!["PENDING", "RUNNING", "DONE", "FAILED"].includes(status)) return c.json({ error: { code: "VALIDATION" } }, 400);
    const rawOffset = c.req.query("offset") ?? "0";
    const offset = Number(rawOffset);
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)) return c.json({ error: { code: "VALIDATION" } }, 400);
    const auth = c.get("auth");
    const pageSize = 100;
    const jobs = await withTenant(db, auth, (tx) => tx`
      SELECT j.id, j.name, j.status, j.attempts, j.last_error, j.created_at,
        CASE j.name WHEN 'document.extract' THEN j.payload->>'documentId'
          WHEN 'import.statement' THEN j.payload->>'accountId'
          WHEN 'dunning.send' THEN j.payload->>'invoiceId' END AS resource_id,
        CASE WHEN j.name = 'dunning.send' THEN j.payload->>'channel' END AS channel,
        r.outcome AS review_outcome, r.reviewed_at
      FROM background_job j LEFT JOIN background_job_review r ON r.source_job_id = j.id AND r.tenant_id = j.tenant_id
      WHERE j.tenant_id = ${auth.tenantId} AND j.status = ${status}
      ORDER BY CASE WHEN j.status = 'FAILED' AND j.name = 'dunning.send' AND r.source_job_id IS NULL THEN 0
          WHEN j.status = 'FAILED' AND r.source_job_id IS NULL THEN 1 ELSE 2 END,
        j.created_at DESC, j.id DESC
      LIMIT ${pageSize + 1} OFFSET ${offset}`);
    return c.json({ jobs: jobs.slice(0, pageSize), hasMore: jobs.length > pageSize });
  });
  api.get("/jobs/:id", async (c) => {
    if (!db || !deps.jobStatusSupported) return c.json({ error: { code: "UNAVAILABLE", message: "Statut de la file indisponible" } }, 503);
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: { code: "VALIDATION" } }, 400);
    const auth = c.get("auth");
    const [job] = await withTenant(db, auth, (tx) => tx`
      SELECT id, name, status, attempts, last_error, created_at
      FROM background_job WHERE id = ${id} AND tenant_id = ${auth.tenantId}`);
    return job ? c.json(job) : c.json({ error: { code: "NOT_FOUND" } }, 404);
  });
  const jobWrite = requireRole("OWNER", "ACCOUNTANT", "CASHIER");
  api.post("/jobs/:id/retry", jobWrite, async (c) => {
    if (!db || !deps.jobStatusSupported || !deps.jobs) return c.json({ error: { code: "UNAVAILABLE" } }, 503);
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: { code: "VALIDATION" } }, 400);
    const auth = c.get("auth");
    const [row] = await withTenant(db, auth, (tx) => tx`SELECT background_job_retry_internal(${id}) AS retried`);
    return row?.retried ? c.json({ id, status: "PENDING" }) : c.json({ error: { code: "CONFLICT", message: "Tâche introuvable ou non réessayable" } }, 409);
  });
  api.post("/jobs/:id/review", jobWrite, async (c) => {
    if (!db || !deps.jobStatusSupported || !deps.jobs) return c.json({ error: { code: "UNAVAILABLE" } }, 503);
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: { code: "VALIDATION" } }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("confirmed" in body) || body.confirmed !== true
      || !("outcome" in body) || (body.outcome !== "DELIVERED" && body.outcome !== "NOT_DELIVERED"))
      return c.json({ error: { code: "VALIDATION", message: "Vérifiez la livraison externe et confirmez votre décision" } }, 400);
    const outcome = body.outcome as "DELIVERED" | "NOT_DELIVERED";
    const auth = c.get("auth");
    const [row] = await withTenant(db, auth, (tx) => tx`
      SELECT background_job_review_reminder(${id}, ${auth.userId}, ${outcome}) AS reviewed`);
    return row?.reviewed
      ? c.json({ id, outcome, replacementScheduled: outcome === "NOT_DELIVERED" })
      : c.json({ error: { code: "CONFLICT", message: "Relance introuvable ou déjà examinée" } }, 409);
  });
  api.route("/portal", portalRoutes(deps));
  api.route("/platform/ai", platformAiRoutes(db));
  api.route("/platform", platformRoutes(db ? (sub: string, mode?: AdminModeEvidence) => mode
    ? modeCompanies(db, sub, mode) : resolvePlatformCompanies(db, sub) : undefined,
    db ? async (sub, mode) => {
      const [row] = await db`SELECT platform_overview(${sub},${mode?.sid ?? null},${mode?.tokenHash ?? null},${mode?.proofHash ?? null}) AS data`;
      return row?.data;
    } : undefined));
  api.route("/company", companyRoutes(deps));
  api.route("/", sessionRoutes(deps));
  api.route("/security/mfa", mfaRoutes(db));
  api.route("/security/admin-mode", adminModeRoutes(db));
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
