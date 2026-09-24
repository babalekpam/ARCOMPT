// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { serve } from "@hono/node-server";
import type { Sql } from "postgres";
import { createDb } from "@arcompt/db";
import { createQueueFromEnv } from "@arcompt/jobs";
import { createCompanyCurrencyResolver, Ledger, PostgresRateProvider, PostgresStore } from "@arcompt/ledger";
import { createApp } from "./app.js";
import { applicationDatabaseUrl } from "./app-database.js";
import { assertDistinctDatabaseUrls, queueDatabaseUrl } from "./queue-database.js";
import { loadConfig } from "./config.js";
import { assertProductionDatabaseSecurity } from "./database-readiness.js";
import { beginDraining } from "./health.js";
import { initTelemetry, log } from "./telemetry.js";
import { PostgresQueue } from "./postgres-queue.js";
import { registerJobHandlers } from "./job-handlers.js";

/**
 * La validation passe avant tout le reste : en production elle lève en listant
 * TOUS les problèmes de configuration, donc le processus ne démarre jamais sur
 * un simulateur (extraction IA inventée, antivirus neutre, stockage éphémère,
 * encaissement fictif, certification fiscale fabriquée).
 */
const cfg = loadConfig();
for (const d of cfg.degraded) log("warn", "api.degraded", { detail: d });

await initTelemetry();

const appDatabaseUrl = applicationDatabaseUrl();
const db = appDatabaseUrl ? createDb({ url: appDatabaseUrl }) : createDb();
const queueUrl = process.env.REDIS_URL ? undefined : queueDatabaseUrl();
if (cfg.isProduction) assertDistinctDatabaseUrls(appDatabaseUrl, queueUrl);
const queueDb = queueUrl ? createDb({ url: queueUrl }) : db;
if (cfg.isProduction) {
  try {
    await assertProductionDatabaseSecurity(db);
  } catch (error) {
    await db.end({ timeout: 5 });
    if (queueDb !== db) await queueDb.end({ timeout: 5 });
    throw error;
  }
}

/**
 * Devise de tenue : celle du dossier, pas celle du processus. Un dossier
 * camerounais en XAF ne doit pas se retrouver tenu en XOF parce que l'API a
 * démarré avec `DEFAULT_CURRENCY=XOF`.
 *
 * Le résolveur est construit ici, une fois, et partagé par toutes les requêtes :
 * relire `company.currency` à chaque écriture coûterait un aller-retour SQL sur
 * le chemin le plus chaud. Son cache expire (5 minutes par défaut) pour qu'une
 * correction de devise soit prise en compte sans redémarrage, et
 * `cfg.baseCurrency` ne sert plus que de repli pour un dossier sans devise.
 */
const currencyResolver = createCompanyCurrencyResolver(db as unknown as Sql);
// Without Redis, jobs live in PostgreSQL and run in this API process. A
// standalone in-memory worker would never see jobs submitted by HTTP requests.
const jobs = process.env.REDIS_URL ? createQueueFromEnv() : new PostgresQueue(db as unknown as Sql, 1000, queueDb as unknown as Sql);
if (jobs instanceof PostgresQueue) {
  // Fail startup instead of accepting uploads with a missing queue migration.
  await db`SELECT id FROM background_job LIMIT 0`;
  if (cfg.isProduction) {
    const [check] = await queueDb`SELECT
      r.rolname AS role, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolinherit,
      has_function_privilege(current_user, to_regprocedure('background_job_claim(text[])'), 'EXECUTE') AS claim,
      has_function_privilege(current_user, to_regprocedure('background_job_finish(uuid,uuid,text)'), 'EXECUTE') AS finish,
      has_function_privilege(current_user, to_regprocedure('background_job_renew(uuid,uuid)'), 'EXECUTE') AS renew,
      has_function_privilege(current_user, to_regprocedure('background_job_expire_reminders()'), 'EXECUTE') AS expire,
      has_table_privilege(current_user, 'public.background_job', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'public.background_job', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'public.background_job', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'public.background_job', 'DELETE') AS can_delete,
      has_table_privilege(current_user, 'public.background_job', 'TRUNCATE') AS can_truncate,
      has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
      (SELECT count(*) = 4 AND count(DISTINCT owner.rolname) = 1
         AND bool_and(p.prosecdef)
         AND bool_and(p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
         AND bool_and(owner.rolname NOT IN (current_user, 'arcompt_app', 'arcompt_queue'))
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles owner ON owner.oid = p.proowner
       WHERE n.nspname = 'public' AND p.oid IN (
         to_regprocedure('public.background_job_claim(text[])'),
         to_regprocedure('public.background_job_renew(uuid,uuid)'),
         to_regprocedure('public.background_job_finish(uuid,uuid,text)'),
         to_regprocedure('public.background_job_expire_reminders()')
       )) AS functions_hardened,
      NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles member ON member.oid = m.member
        JOIN pg_roles group_role ON group_role.oid = m.roleid
        WHERE member.rolname = current_user AND group_role.rolname = 'arcompt_app'
      ) AS no_app_membership
      FROM pg_roles r WHERE r.rolname = current_user`;
    if (!check || check.rolsuper || check.rolbypassrls || check.rolcreaterole || check.rolcreatedb || !check.rolinherit ||
      check.can_select || check.can_insert || check.can_update || check.can_delete || check.can_truncate ||
      !check.schema_usage || !check.functions_hardened || !check.no_app_membership ||
      !check.claim || !check.finish || !check.renew || !check.expire)
      throw new Error("Fonctions de la file PostgreSQL manquantes : démarrage refusé");
    const [appCheck] = await db`SELECT current_user AS role,
      has_function_privilege(current_user, to_regprocedure('background_job_claim(text[])'), 'EXECUTE') AS claim,
      has_function_privilege(current_user, to_regprocedure('background_job_finish(uuid,uuid,text)'), 'EXECUTE') AS finish,
      has_function_privilege(current_user, to_regprocedure('background_job_renew(uuid,uuid)'), 'EXECUTE') AS renew,
      has_function_privilege(current_user, to_regprocedure('background_job_expire_reminders()'), 'EXECUTE') AS expire`;
    if (appCheck?.role === check.role)
      throw new Error("APP_DATABASE_URL et QUEUE_DATABASE_URL utilisent le même rôle PostgreSQL");
    if (appCheck?.claim || appCheck?.finish || appCheck?.renew || appCheck?.expire)
      throw new Error("Le rôle applicatif conserve EXECUTE sur les fonctions cross-tenant de la file");
  }
  registerJobHandlers(jobs, db as unknown as Sql);
  jobs.start();
}

const app = createApp({
  jobs,
  jobStatusSupported: jobs instanceof PostgresQueue,
  db: db as unknown as Sql,
  auth: {
    mode: cfg.auth.mode,
    ...(cfg.auth.issuer ? { issuer: cfg.auth.issuer } : {}),
    ...(cfg.auth.audience ? { audience: cfg.auth.audience } : {}),
    ...(cfg.auth.secretKey ? { clerkSecretKey: cfg.auth.secretKey } : {}),
    ...(cfg.auth.authorizedParties ? { authorizedParties: cfg.auth.authorizedParties } : {}),
  },
  ledgerFor: (ctx) =>
    new Ledger(new PostgresStore(db as unknown as Sql, { userId: ctx.userId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }), {
      baseCurrency: cfg.baseCurrency,
      currencyResolver,
      rates: new PostgresRateProvider(db as unknown as Sql, { userId: ctx.userId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }),
    }),
});

// Only the Next.js frontend is public in production. The API is reached by
// Next.js over the local loopback interface and must not accept direct traffic.
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0" }, () => {
  log("info", "api.started", {
    port: cfg.port,
    auth: cfg.auth.mode,
    storage: cfg.storage.driver,
    antivirus: cfg.antivirus.driver,
    payments: cfg.payments.enabled ? cfg.payments.provider : "désactivé",
    degraded: cfg.degraded.length,
  });
});

/**
 * Arrêt en douceur (même schéma que `worker.ts`). Une écriture comptable est
 * une transaction multi-instructions : la couper en plein vol laisse un
 * brouillon orphelin ou une numérotation en attente. L'ordre compte :
 *
 *   1. `/ready` répond 503 : l'équilibreur cesse d'envoyer du trafic neuf ;
 *   2. le serveur HTTP n'accepte plus de connexion, les requêtes en cours
 *      finissent, dans la limite du délai de grâce ;
 *   3. le pool PostgreSQL est fermé, transactions terminées.
 *
 * Délai de grâce : `SHUTDOWN_GRACE_MS` (10 s par défaut), à tenir sous le
 * `terminationGracePeriodSeconds` de l'orchestrateur, qui enverra SIGKILL.
 */
const DEFAULT_GRACE_MS = 10_000;
const configuredGrace = Number(process.env.SHUTDOWN_GRACE_MS);
// Une valeur illisible ne doit pas se traduire par un délai nul, c'est-à-dire
// par la coupure immédiate des requêtes en cours.
const GRACE_MS = Number.isFinite(configuredGrace) && configuredGrace > 0 ? configuredGrace : DEFAULT_GRACE_MS;
const POOL_CLOSE_TIMEOUT_S = 5;
let stopping = false;

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return; // un second signal ne relance pas la séquence
  stopping = true;
  beginDraining();
  log("info", "api.shutdown.start", { signal, graceMs: GRACE_MS });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log("warn", "api.shutdown.grace_exceeded", { graceMs: GRACE_MS });
      resolve();
    }, GRACE_MS);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    // Les connexions persistantes inactives retiendraient le serveur ouvert
    // jusqu'au délai de grâce sans rien servir.
    const idle = (server as { closeIdleConnections?: () => void }).closeIdleConnections;
    if (typeof idle === "function") idle.call(server);
  });

  try {
    await jobs.close();
    await db.end({ timeout: POOL_CLOSE_TIMEOUT_S });
    if (queueDb !== db) await queueDb.end({ timeout: POOL_CLOSE_TIMEOUT_S });
  } catch (e) {
    log("error", "api.shutdown.pool_close_failed", { detail: e instanceof Error ? e.message : String(e) });
  }
  log("info", "api.shutdown.done", { signal });
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
