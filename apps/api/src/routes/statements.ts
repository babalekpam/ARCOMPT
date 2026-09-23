// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono } from "hono";
import { z } from "zod";
import { computeStatements } from "@arcompt/statements";
import type { AppDeps } from "../app.js";

export function statementsRoutes(deps: AppDeps) {
  const r = new Hono();

  /**
   * États financiers d'un exercice, calculés depuis la balance du grand livre.
   * Fonction pure côté moteur : la route ne fait que lire la balance N (et N-1).
   */
  r.get("/", async (c) => {
    const auth = c.get("auth");
    const q = z
      .object({
        fiscalYear: z.string(),
        previousFiscalYear: z.string().optional(),
        system: z.enum(["NORMAL", "SMT"]).default("NORMAL"),
        // Sans précision, les états sortent dans la devise de tenue du dossier,
        // pas dans une devise par défaut du processus.
        currency: z.string().length(3).optional(),
        templateVersion: z.string().optional(),
      })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "fiscalYear requis", details: q.error.issues } }, 400);
    const ledger = deps.ledgerFor(auth);
    const current = await ledger.trialBalance(auth.tenantId, { fiscalYearCode: q.data.fiscalYear });
    const previous = q.data.previousFiscalYear ? await ledger.trialBalance(auth.tenantId, { fiscalYearCode: q.data.previousFiscalYear }) : null;
    const out = computeStatements({
      system: q.data.system,
      currency: q.data.currency ?? current.currency,
      // La devise réellement portée par la balance : le moteur d'états la
      // confronte à la devise de présentation par un contrôle bloquant.
      balanceCurrency: current.currency,
      fiscalYearCode: q.data.fiscalYear,
      balance: current.rows,
      ...(previous ? { previousBalance: previous.rows } : {}),
      ...(q.data.templateVersion ? { templateVersion: q.data.templateVersion } : {}),
    });
    return c.json(out);
  });

  return r;
}
