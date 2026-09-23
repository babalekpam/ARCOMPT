// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Ancrage quotidien : calcule l'ancre de chaque journée révolue et la publie
 * hors de la plateforme (SECURITY.md § 6, engagement n° 10).
 *
 *   ANCHOR_PUBLISHER=rfc3161 ANCHOR_TSA_URL=https://… \
 *   DATABASE_URL=postgres://<compte_de_service>@… \
 *     pnpm exec tsx scripts/anchor-daily.mts
 *
 * À poser dans l'ordonnanceur, une fois par jour, après minuit UTC. Idempotent :
 * relancé, il ne refait que ce qui manque ; une exécution qui a échoué la veille
 * est rattrapée le lendemain, sans trou dans la chaîne d'ancres.
 *
 * Le script s'exécute avec un compte capable de **lire tous les dossiers**
 * (`company` est en RLS forcée) : le compte de migration ou un compte de
 * service dédié, jamais le rôle applicatif. S'il n'énumère aucun dossier alors
 * que la base en contient, il le dit au lieu de terminer sur un succès vide.
 *
 * Options :
 *   --tenant <uuid>   n'ancrer qu'un dossier (répétable)
 *   --dry-run         énumérer les jours à ancrer sans rien écrire ni publier
 */

import type { Sql } from "postgres";
import { createDb } from "../packages/db/src/client.js";
import { AnchoringService, PostgresAnchorStore, anchorPublisherFromEnv, utcDay } from "../packages/ledger/src/index.js";
import { fail, flag, maskUrl } from "./lib/pg.mts";

const argv = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL absent.");

const config = anchorPublisherFromEnv(process.env);
for (const problem of config.problems) console.error(`✗ ${problem}`);
if (config.problems.length > 0) process.exit(1);
for (const degraded of config.degraded) console.warn(`[arcompt] DÉGRADÉ : ${degraded}`);
if (!config.publisher) {
  // Rien de configuré : l'ancrage est coupé, et c'est une décision
  // d'exploitation, pas une panne. On le dit et on s'arrête — jamais d'ancre
  // calculée « en attendant », qui ressemblerait à une preuve sans en être une.
  console.error("✗ Aucun publieur d'ancres configuré : rien n'est calculé ni publié. Posez ANCHOR_PUBLISHER (voir docs/OPERATIONS.md).");
  process.exit(1);
}

const db = createDb({ url, max: 4 });
const explicitTenants = argv.flatMap((a, i) => (a === "--tenant" && argv[i + 1] ? [argv[i + 1]!] : a.startsWith("--tenant=") ? [a.slice(9)] : []));
const dryRun = flag(argv, "dry-run");

let exitCode = 0;
try {
  const store = new PostgresAnchorStore(db as unknown as Sql);
  const tenants = explicitTenants.length > 0 ? explicitTenants : await store.allTenantIds();

  console.log(`Ancrage quotidien — ${maskUrl(url)}`);
  console.log(`  publieur : ${config.publisher.name}`);
  console.log(`  jour de référence (UTC) : ${utcDay(new Date())} — seules les journées révolues sont ancrées`);
  console.log(`  dossiers : ${tenants.length}${explicitTenants.length > 0 ? " (imposés par --tenant)" : ""}`);
  console.log("");

  if (tenants.length === 0) {
    console.error("✗ aucun dossier énuméré. Soit la base est vide, soit le compte employé ne voit pas `company` (RLS forcée) :");
    console.error("  relancez avec le compte de migration ou un compte de service, pas avec le rôle applicatif.");
    process.exit(1);
  }

  for (const tenantId of tenants) {
    if (dryRun) {
      const days = await store.pendingDays(tenantId, utcDay(new Date()));
      console.log(`  ${tenantId} : ${days.length === 0 ? "rien à ancrer" : `${days.length} jour(s) à ancrer — ${days.join(", ")}`}`);
      continue;
    }

    const service = new AnchoringService({ store, publisher: config.publisher });
    const report = await service.run(tenantId);
    const parts = [
      `${report.built.length} ancre(s) calculée(s)`,
      `${report.published.length} publiée(s)`,
      report.failed.length > 0 ? `${report.failed.length} en échec` : "",
    ].filter((p) => p !== "");
    console.log(`  ${tenantId} : ${parts.join(", ")}`);

    for (const p of report.published) console.log(`      ${p.day} → ${p.publisher} ${p.reference} (${p.publishedAt})`);
    for (const f of report.failed) {
      console.error(`      ✗ ${f.day} : ${f.error}`);
      exitCode = 1;
    }
    if (report.unanchorable.length > 0) {
      // Une journée d'activité antérieure à la dernière ancre ne peut plus
      // entrer dans la chaîne. C'est le signe d'une écriture antidatée ou d'une
      // horloge qui a reculé : à examiner, jamais à ignorer.
      console.error(`      ! jours d'activité désormais inancrables : ${report.unanchorable.join(", ")}`);
      exitCode = 1;
    }
  }
} finally {
  await db.end();
}

console.log("");
console.log(exitCode === 0 ? "✓ ancrage quotidien terminé." : "✗ ancrage quotidien incomplet : des ancres ne sont pas sorties de la plateforme.");
process.exit(exitCode);
