// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import postgres, { type Sql } from "postgres";

export type Db = Sql;

export interface DbOptions {
  url?: string;
  max?: number;
}

/** Connexion PostgreSQL. Les montants NUMERIC sont renvoyés en chaînes, jamais en flottants. */
export function createDb(opts: DbOptions = {}): Db {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL manquant");
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {}, // les NOTICE des migrations (extensions déjà présentes) n'ont pas à polluer la sortie
    transform: { undefined: null },
    types: {
      // numeric (oid 1700) : chaîne brute, pas de Number()
      numeric: { to: 1700, from: [1700], serialize: (v: unknown) => String(v), parse: (v: string) => v },
    },
  });
}

/**
 * Exécute `fn` dans une transaction dont le contexte tenant est fixé pour la
 * RLS. Le tenant vient du jeton côté API, jamais du client.
 */
export async function withTenant<T>(
  db: Db,
  ctx: { tenantId: string; organizationId?: string; userId?: string },
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${ctx.tenantId}, true)`;
    await tx`select set_config('app.organization_id', ${ctx.organizationId ?? ""}, true)`;
    await tx`select set_config('app.user_id', ${ctx.userId ?? ""}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
