// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDb, type Db } from "./client.js";
import { migrate } from "./migrate.js";

/**
 * Base de test jetable : une base par exécution, migrée, supprimée à la fin.
 * Nécessite DATABASE_URL avec les droits CREATE DATABASE (superuser en local).
 */
export async function createTestDatabase(): Promise<{ db: Db; appDb: Db; url: string; drop: () => Promise<void> } | null> {
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  const name = `arcompt_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = postgres(base, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (e) {
    await admin.end();
    if (process.env.CI) throw e;
    return null;
  }
  const url = base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const db = createDb({ url, max: 2 });
  await migrate(db);
  // Connexion « applicative » : rôle sans privilège de contournement de la RLS.
  await db.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arcompt_app_login') THEN CREATE ROLE arcompt_app_login LOGIN PASSWORD 'arcompt_app' IN ROLE arcompt_app; END IF; END $$`);
  const appUrl = new URL(url);
  appUrl.username = "arcompt_app_login";
  appUrl.password = "arcompt_app";
  const appDb = createDb({ url: appUrl.toString(), max: 2 });
  return {
    db,
    appDb,
    url,
    drop: async () => {
      await appDb.end();
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
