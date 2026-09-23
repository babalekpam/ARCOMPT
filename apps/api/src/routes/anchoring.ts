// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Ancrage externe : lecture des ancres, preuve d'inclusion d'une écriture, et
 * déclenchement manuel de l'ancrage d'un dossier (SECURITY.md §6, engagement
 * n° 10).
 *
 * Ce que ces routes servent, et à qui. Un commissaire aux comptes veut, pour
 * une écriture donnée, trois choses : l'ancre qui couvre son jour, la preuve
 * de Merkle qui relie l'écriture à cette ancre, et la trace tierce qui date
 * l'ancre. `GET /v1/anchors/proof?entry=…` renvoie les trois d'un coup, plus
 * le reçu exact à re-hacher, pour qu'il puisse refaire le calcul sans nous.
 *
 * Configuration. Sans `ANCHOR_PUBLISHER`, l'ancrage est **coupé** : les routes
 * de lecture répondent toujours (il peut exister des ancres plus anciennes),
 * mais toute production d'ancre répond 503 en nommant la variable manquante.
 * Jamais de publication simulée : une ancre qui n'est pas sortie n'est pas
 * marquée publiée.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AnchoringError,
  AnchoringService,
  PostgresAnchorStore,
  anchorPublisherFromEnv,
  anchorReceipt,
  recomputeAnchor,
  toAnchor,
  type AnchorRecord,
  type AnchoringErrorCode,
} from "@arcompt/ledger";
import { requireRole } from "../auth.js";
import { ConfigError } from "../config.js";
import { log } from "../telemetry.js";
import type { AppDeps } from "../app.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function errorStatus(code: AnchoringErrorCode): 404 | 409 | 502 | 503 {
  switch (code) {
    case "ANCHORING_DISABLED":
      return 503;
    case "ANCHOR_NOT_FOUND":
    case "LEAF_NOT_FOUND":
      return 404;
    case "PUBLICATION_FAILED":
      return 502;
    default:
      return 409;
  }
}

/** Vue publique d'une ancre. La preuve tierce, volumineuse, n'est servie qu'à l'unité. */
function view(record: AnchorRecord, opts: { proof?: boolean } = {}) {
  return {
    day: record.day,
    merkleRoot: record.merkleRoot,
    prevAnchorHash: record.prevAnchorHash,
    anchorHash: record.anchorHash,
    leafCount: record.entryCount,
    counts: record.counts,
    builtAt: record.builtAt,
    status: record.status,
    publisher: record.publisher,
    reference: record.publicationRef,
    publishedAt: record.publishedAt,
    publicationError: record.publicationError,
    /** Texte exact dont l'empreinte sha256 a été soumise au tiers : c'est lui qu'un auditeur re-hache. */
    receipt: anchorReceipt(toAnchor(record)),
    ...(opts.proof ? { publicationProof: record.publicationProof } : {}),
  };
}

export function anchoringRoutes(deps: AppDeps) {
  const r = new Hono();

  // Lue une fois au montage, comme le reste de la configuration : en
  // production, une configuration d'ancrage posée à moitié empêche de démarrer
  // plutôt que d'échouer silencieusement chaque nuit.
  const config = anchorPublisherFromEnv(process.env);
  if (config.problems.length > 0) {
    if (process.env.NODE_ENV === "production") throw new ConfigError(config.problems);
    for (const p of config.problems) console.warn(`[arcompt] configuration d'ancrage non conforme à la production : ${p}`);
  }
  for (const d of config.degraded) {
    if (!deps.quiet) log("warn", "anchoring.degraded", { detail: d });
  }

  const storeFor = (c: Context): PostgresAnchorStore | null => {
    if (!deps.db) return null;
    const auth = c.get("auth");
    return new PostgresAnchorStore(deps.db, { userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) });
  };

  const service = (c: Context): AnchoringService | null => {
    const store = storeFor(c);
    if (!store) return null;
    return new AnchoringService({ store, publisher: config.publisher, builtBy: c.get("auth").userId });
  };

  const guard = (fn: (c: Context, s: AnchoringService) => Promise<Response>) => async (c: Context) => {
    const s = service(c);
    if (!s) return c.json({ error: { code: "DB_UNAVAILABLE", message: "Base de données indisponible" } }, 503);
    try {
      return await fn(c, s);
    } catch (e) {
      if (e instanceof AnchoringError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, errorStatus(e.code));
      throw e;
    }
  };

  const invalid = (c: Context, issues: unknown) => c.json({ error: { code: "VALIDATION", message: "Entrée invalide", details: issues } }, 400);

  /** État de l'ancrage du dossier : ce qui est configuré, ce qui est ancré, ce qui ne l'est pas. */
  r.get(
    "/",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "AUDITOR"),
    guard(async (c, s) => {
      const q = z.object({ from: z.string().regex(DAY).optional(), to: z.string().regex(DAY).optional() }).safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const auth = c.get("auth");
      const store = storeFor(c)!;
      const anchors = await store.listAnchors(auth.tenantId, { ...(q.data.from ? { from: q.data.from } : {}), ...(q.data.to ? { to: q.data.to } : {}) });
      return c.json({
        enabled: s.enabled,
        publisher: config.requested === "" ? null : config.requested,
        degraded: config.degraded,
        anchors: anchors.map((a) => view(a)),
      });
    }),
  );

  /**
   * Vérification complète : chaînage des ancres **et** recalcul de chaque
   * racine depuis les données d'aujourd'hui. C'est le second contrôle qui
   * détecte une modification a posteriori ; le premier ne verrait qu'une
   * réécriture de la table d'ancres.
   */
  r.get(
    "/chain",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "AUDITOR"),
    guard(async (c, s) => c.json(await s.verifyChain(c.get("auth").tenantId))),
  );

  /** Preuve d'inclusion d'une écriture validée (`?entry=<uuid>`) ou d'une ligne d'audit (`?audit=<id>`). */
  r.get(
    "/proof",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "AUDITOR"),
    guard(async (c, s) => {
      const q = z
        .object({ entry: z.string().uuid().optional(), audit: z.string().regex(/^\d+$/).optional() })
        .refine((v) => Boolean(v.entry) !== Boolean(v.audit), { message: "Fournissez « entry » ou « audit », pas les deux." })
        .safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error.issues);
      const auth = c.get("auth");
      const result = await s.proofFor(auth.tenantId, { ...(q.data.entry ? { entryId: q.data.entry } : {}), ...(q.data.audit ? { auditId: q.data.audit } : {}) });
      return c.json({
        anchor: view(result.anchor, { proof: true }),
        leaf: result.leaf,
        proof: result.proof,
        verified: result.verified,
        rootMatchesToday: result.rootMatchesToday,
        published: result.published,
      });
    }),
  );

  /**
   * Ancre les jours révolus non encore ancrés, puis publie tout ce qui n'est
   * pas sorti. Idempotent : relancé, il ne refait que ce qui manque. La tâche
   * quotidienne (`scripts/anchor-daily.mts`) appelle le même chemin.
   */
  r.post(
    "/build",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER"),
    guard(async (c, s) => {
      const body = z.object({ day: z.string().regex(DAY).optional() }).safeParse((await c.req.json().catch(() => ({}))) ?? {});
      if (!body.success) return invalid(c, body.error.issues);
      const auth = c.get("auth");
      if (body.data.day) {
        const built = await s.buildDay(auth.tenantId, body.data.day);
        const published = await s.publish(built);
        return c.json({ anchor: view(published) }, 201);
      }
      return c.json(await s.run(auth.tenantId));
    }),
  );

  /** Ancre d'un jour donné, preuve tierce comprise. */
  r.get(
    "/:day",
    requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "AUDITOR"),
    guard(async (c) => {
      const day = c.req.param("day")!;
      if (!DAY.test(day)) return invalid(c, [{ message: "Jour attendu au format AAAA-MM-JJ" }]);
      const auth = c.get("auth");
      const store = storeFor(c)!;
      const record = await store.getAnchor(auth.tenantId, day);
      if (!record) return c.json({ error: { code: "ANCHOR_NOT_FOUND", message: `Aucune ancre pour le ${day}.` } }, 404);
      const leaves = await store.dailyLeaves(auth.tenantId, day);
      const recomputedOk = recomputeAnchor(record, leaves).ok;
      return c.json({ ...view(record, { proof: true }), rootMatchesToday: recomputedOk });
    }),
  );

  return r;
}
