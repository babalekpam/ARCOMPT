import { serve } from "@hono/node-server";
import type { Sql } from "postgres";
import { createDb } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 4000);
const mode = (process.env.AUTH_MODE ?? "dev") as "dev" | "oidc";
const db = createDb();

const app = createApp({
  db: db as unknown as Sql,
  auth: { mode, ...(process.env.KEYCLOAK_ISSUER ? { issuer: process.env.KEYCLOAK_ISSUER } : {}), ...(process.env.KEYCLOAK_CLIENT_ID ? { audience: process.env.KEYCLOAK_CLIENT_ID } : {}) },
  ledgerFor: (ctx) =>
    new Ledger(new PostgresStore(db as unknown as Sql, { userId: ctx.userId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }), {
      baseCurrency: process.env.DEFAULT_CURRENCY ?? "XOF",
    }),
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`ARCOMPT API sur http://localhost:${port} (auth ${mode})`);
});
