// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono } from "hono";
import { z } from "zod";
import { withTenant } from "@arcompt/db";
import type { AppDeps } from "../app.js";

/**
 * Plan de comptes du dossier courant. Lecture directe de la table `account`
 * sous RLS (withTenant) : le moteur comptable n'expose pas de listAccounts.
 * Sans connexion PostgreSQL (tests en mémoire), la liste est vide.
 */
export interface AccountRow {
  id: string;
  number: string;
  label: string;
  class: number;
  nature: string;
  lettrable: boolean;
  postable: boolean;
  active: boolean;
}

export function accountsRoutes(deps: AppDeps) {
  const r = new Hono();

  r.get("/", async (c) => {
    const auth = c.get("auth");
    const q = z
      .object({
        q: z.string().max(100).optional(),
        class: z.string().regex(/^[1-9]$/).optional(),
        postable: z.enum(["true", "false"]).optional(),
        includeInactive: z.enum(["true", "false"]).optional(),
      })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: { code: "VALIDATION", message: "Paramètres invalides", details: q.error.issues } }, 400);
    if (!deps.db) return c.json({ accounts: [] as AccountRow[] });

    const { q: search, class: cls, postable, includeInactive } = q.data;
    const pattern = search ? `%${search.replace(/[%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await withTenant(deps.db, { tenantId: auth.tenantId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}), userId: auth.userId }, (tx) =>
      tx<AccountRow[]>`
        SELECT id, number, label, class, nature, lettrable, postable, active
        FROM account
        WHERE tenant_id = ${auth.tenantId}
          ${includeInactive === "true" ? tx`` : tx`AND active = true`}
          ${cls ? tx`AND class = ${Number(cls)}` : tx``}
          ${postable ? tx`AND postable = ${postable === "true"}` : tx``}
          ${pattern ? tx`AND (number LIKE ${pattern} OR label ILIKE ${pattern})` : tx``}
        ORDER BY number`,
    );
    return c.json({ accounts: rows });
  });

  return r;
}
