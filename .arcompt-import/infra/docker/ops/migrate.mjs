#!/usr/bin/env node
// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Lancement des migrations sous verrou consultatif PostgreSQL.
 *
 * `packages/db/src/migrate.ts` applique les migrations manquantes, chacune dans
 * sa transaction, mais NE PREND AUCUN VERROU : deux exécutions simultanées
 * (redéploiement pendant qu'un déploiement tourne, deux nœuds qui démarrent en
 * même temps) peuvent lire `schema_migration` avant que l'autre n'ait inscrit
 * son avancement, puis rejouer le même fichier. Ce paquet appartient à un autre
 * périmètre : plutôt que de le modifier, l'orchestration pose le verrou ici.
 *
 * `pg_advisory_lock` est un verrou de SESSION : il est tenu par la connexion,
 * pas par une transaction, donc il couvre toute la suite des migrations. La
 * connexion est ouverte avec `max: 1` pour que les transactions de `migrate()`
 * empruntent exactement cette session, celle qui détient le verrou.
 *
 * Si un autre processus migre déjà, on attend en le disant, au lieu de bloquer
 * en silence — un déploiement figé sans message est indébogable.
 *
 * L'image de production place ce fichier au MÊME chemin que dans le dépôt
 * (`/app/infra/docker/ops/`), pour que les imports relatifs ci-dessous soient
 * vrais des deux côtés. Depuis un dépôt, il s'exécute donc tel quel :
 *
 *   DATABASE_URL=… pnpm exec tsx infra/docker/ops/migrate.mjs
 */
import console from "node:console";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { createDb } from "../../../packages/db/src/client.js";
import { migrate } from "../../../packages/db/src/migrate.js";

/** Identifiant arbitraire mais stable du verrou « migrations ARCOMPT ». */
const LOCK_KEY = 4_120_907_314_882_551n;

/** Délai maximal d'attente du verrou, en secondes (0 = attendre indéfiniment). */
const WAIT_SECONDS = Number(process.env.MIGRATION_LOCK_TIMEOUT ?? 300);

const db = createDb({ max: 1 });

/** Tente le verrou toutes les 2 s ; renvoie false si le délai est dépassé. */
async function acquire() {
  const deadline = WAIT_SECONDS > 0 ? Date.now() + WAIT_SECONDS * 1000 : Infinity;
  let announced = false;
  for (;;) {
    const [row] = await db`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`;
    if (row?.ok === true) return true;
    if (Date.now() >= deadline) return false;
    if (!announced) {
      console.log("[migrations] une autre migration est en cours, attente du verrou consultatif…");
      announced = true;
    }
    await sleep(2000);
  }
}

try {
  if (!(await acquire())) {
    console.error(`[migrations] verrou non obtenu après ${WAIT_SECONDS} s — une migration est bloquée ailleurs. Rien n'a été appliqué.`);
    process.exit(1);
  }
  const applied = await migrate(db, { log: (m) => console.log(`[migrations] ${m}`) });
  console.log(applied.length === 0 ? "[migrations] schéma à jour" : `[migrations] ${applied.length} migration(s) appliquée(s)`);
  await db`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  await db.end();
} catch (error) {
  console.error("[migrations] échec :", error);
  await db.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
