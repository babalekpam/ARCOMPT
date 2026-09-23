// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./client.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applique les migrations SQL manquantes, dans l'ordre, chacune dans sa transaction. */
export async function migrate(db: Db, opts: { log?: (msg: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  await db`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await db`SELECT name FROM schema_migration`).map((r) => r.name as string));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migration (name) VALUES (${file})`;
    });
    log(`migration appliquée : ${file}`);
    done.push(file);
  }
  return done;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const db = createDb();
  migrate(db, { log: console.log })
    .then((d) => {
      console.log(d.length === 0 ? "schéma à jour" : `${d.length} migration(s) appliquée(s)`);
      return db.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
