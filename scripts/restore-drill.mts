// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Exercice de restauration (OPERATIONS.md, « Sauvegardes et reprise » —
 * trimestriel).
 *
 *   BACKUP_ENCRYPTION_KEY=… DATABASE_URL=postgres://arcompt@localhost:5432/arcompt \
 *     pnpm exec tsx scripts/restore-drill.mts
 *
 * Ce que l'exercice répond, et pourquoi la question est plus dure qu'elle n'en
 * a l'air. « La restauration a marché » ne veut rien dire : un `psql` qui rend
 * la main sans erreur prouve que du SQL s'est exécuté, pas que la comptabilité
 * est intacte. Un dump tronqué à 90 %, une table perdue, une ligne d'audit
 * disparue au passage — tout cela restaure « sans erreur ».
 *
 * Le harnais restaure donc dans une base jetable, puis **contrôle ce qu'il a
 * restauré**, et n'affiche « ✓ » que si chaque contrôle a réellement porté sur
 * quelque chose :
 *
 *   1. l'historique des migrations est celui de la sauvegarde ;
 *   2. les décomptes de lignes sont ceux de la sauvegarde ;
 *   3. tous les dossiers sauvegardés sont énumérables (sinon les contrôles
 *      suivants porteraient sur un sous-ensemble sans le dire) ;
 *   4. les chaînes de hash du grand livre se recalculent, journal par journal ;
 *   5. la chaîne de la piste d'audit se recalcule, ligne par ligne ;
 *   6. la chaîne d'ancres tient, et chaque racine de Merkle se recalcule depuis
 *      les données restaurées ;
 *   7. les soldes par compte et période se recalculent depuis les lignes.
 *
 * Un contrôle qui n'a rien pu examiner est marqué « IGNORÉ » et n'est jamais
 * compté comme réussi. Le script sort en code 1 dès qu'un contrôle échoue, et
 * conserve alors la base d'exercice pour l'autopsie.
 *
 * Options :
 *   --file <archive>   archive à éprouver (défaut : la plus récente de --dir)
 *   --dir <répertoire> où chercher l'archive (défaut : ./backups)
 *   --admin <url>      base de service ayant le droit CREATE DATABASE (défaut : DATABASE_URL)
 *   --keep             ne pas supprimer la base d'exercice même en cas de succès
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { createDb } from "../packages/db/src/client.js";
import { AnchoringService, Ledger, PostgresAnchorStore, PostgresStore } from "../packages/ledger/src/index.js";
import { arg, fail, flag, maskUrl, parseTarget, psqlValue, run, withDatabase } from "./lib/pg.mts";
import { masterKey } from "./lib/backup-archive.mts";
import { restoreArchive, RestoreError } from "./lib/restore-core.mts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "db", "migrations");

type Status = "OK" | "ÉCHEC" | "IGNORÉ";
interface Check {
  name: string;
  status: Status;
  /** Ce qui a réellement été examiné : un contrôle sans volume n'est pas un contrôle. */
  examined: string;
  detail?: string;
}

const checks: Check[] = [];
const ok = (name: string, examined: string, detail?: string) => checks.push({ name, status: "OK", examined, ...(detail ? { detail } : {}) });
const ko = (name: string, examined: string, detail: string) => checks.push({ name, status: "ÉCHEC", examined, detail });
const skip = (name: string, detail: string) => checks.push({ name, status: "IGNORÉ", examined: "rien", detail });

const argv = process.argv.slice(2);
const adminUrl = arg(argv, "admin") ?? process.env.DATABASE_URL;
if (!adminUrl) fail("DATABASE_URL absent (ou --admin) : le harnais a besoin d'une base de service pour créer la base d'exercice.");

const key = (() => {
  try {
    return masterKey();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();

// --- archive à éprouver -----------------------------------------------------
async function latestArchive(dir: string): Promise<string> {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".sql.gz.enc"));
  if (files.length === 0) throw new Error(`aucune archive (*.sql.gz.enc) dans ${dir} : lancez d'abord scripts/backup.mts.`);
  const dated = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs })));
  return join(dir, dated.sort((a, b) => b.mtime - a.mtime)[0]!.f);
}

const archive = arg(argv, "file") ?? (await latestArchive(arg(argv, "dir") ?? "backups").catch((e: Error) => fail(e.message)));

// --- base d'exercice --------------------------------------------------------
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const drillDb = `arcompt_drill_${stamp}`;
const drillUrl = withDatabase(adminUrl, drillDb);
if (!parseTarget(drillUrl).scratch) fail(`nom de base d'exercice inattendu (${drillDb}) : il doit s'annoncer jetable.`);

console.log("Exercice de restauration ARCOMPT");
console.log(`  archive  : ${archive}`);
console.log(`  service  : ${maskUrl(adminUrl)}`);
console.log(`  cible    : ${drillDb} (créée puis supprimée)`);
console.log("");

const created = await run("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${drillDb}"`]);
if (created.code !== 0) fail(`création de la base d'exercice impossible : ${created.stderr.trim()}`);

let db: Sql | null = null;
let failures = 0;

try {
  // --- 1 & 2 : restauration, migrations, décomptes --------------------------
  const outcome = await restoreArchive({ file: archive, targetUrl: drillUrl, key, log: (m) => console.log(`  → ${m}`) }).catch((e: unknown) => {
    if (e instanceof RestoreError) {
      ko("restauration", "l'archive entière", e.message);
      return null;
    }
    throw e;
  });

  if (!outcome) {
    failures++;
  } else {
    ok("restauration", `${outcome.plaintextBytes} octets de SQL`, `${outcome.migrations} migration(s) rejouée(s)`);

    const applied = (await psqlValue(drillUrl, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migration")).split(",").filter((m) => m !== "");
    const expected = outcome.manifest?.migrations ?? [];
    const missing = expected.filter((m) => !applied.includes(m));
    if (missing.length > 0) ko("historique des migrations", `${applied.length} migration(s)`, `absentes après restauration : ${missing.join(", ")}`);
    else ok("historique des migrations", `${applied.length} migration(s)`, `identique à la sauvegarde (dernière : ${applied.at(-1) ?? "aucune"})`);

    // Informatif : une sauvegarde plus ancienne que le dépôt est normale.
    const repoMigrations = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const behind = repoMigrations.filter((m) => !applied.includes(m));
    if (behind.length > 0) console.log(`  (note : cette sauvegarde précède ${behind.length} migration(s) du dépôt : ${behind.join(", ")})`);

    if (outcome.drift.length > 0) {
      ko("décomptes de lignes", Object.keys(outcome.counts).length + " table(s) témoins", outcome.drift.map((d) => `${d.table} ${d.restored ?? "?"}/${d.expected}`).join(", "));
    } else if (Object.keys(outcome.counts).length === 0) {
      skip("décomptes de lignes", "aucun témoin dans le manifeste.");
    } else {
      ok("décomptes de lignes", Object.entries(outcome.counts).map(([t, n]) => `${t}=${n}`).join(", "), "identiques à la sauvegarde");
    }
  }

  db = createDb({ url: drillUrl, max: 4 });

  // --- 3 : énumération des dossiers ----------------------------------------
  const companies = await db<{ id: string; organization_id: string; name: string }[]>`SELECT id, organization_id, name FROM company ORDER BY created_at`;
  const expectedCompanies = outcome?.manifest?.counts.company;
  if (expectedCompanies !== undefined && companies.length !== expectedCompanies) {
    ko(
      "énumération des dossiers",
      `${companies.length} dossier(s) lus`,
      `${expectedCompanies} attendus. Le compte employé ne voit pas tous les dossiers (RLS forcée sur company) : ` +
        "les contrôles suivants ne porteraient que sur une partie du grand livre. Relancez l'exercice avec un compte de service.",
    );
  } else if (companies.length === 0) {
    skip("énumération des dossiers", "la sauvegarde ne contient aucun dossier — il n'y a rien à vérifier.");
  } else {
    ok("énumération des dossiers", `${companies.length} dossier(s)`, companies.map((c) => c.name).join(", ").slice(0, 120));
  }

  // --- 4 : chaînes de hash du grand livre ----------------------------------
  let journalsChecked = 0;
  let entriesChecked = 0;
  const brokenChains: string[] = [];
  for (const company of companies) {
    const store = new PostgresStore(db as unknown as Sql, { organizationId: company.organization_id });
    const ledger = new Ledger(store, { baseCurrency: "XOF" });
    for (const journal of await store.listJournals(company.id)) {
      const result = await ledger.verifyChain(company.id, journal.code);
      journalsChecked++;
      entriesChecked += result.checked;
      if (!result.ok) brokenChains.push(`${company.name}/${journal.code} (écriture ${result.brokenAt})`);
    }
  }
  if (companies.length === 0) skip("chaînes de hash du grand livre", "aucun dossier à parcourir.");
  else if (entriesChecked === 0) skip("chaînes de hash du grand livre", `${journalsChecked} journal/journaux parcourus, mais aucune écriture validée à vérifier.`);
  else if (brokenChains.length > 0) ko("chaînes de hash du grand livre", `${entriesChecked} écriture(s) sur ${journalsChecked} journal/journaux`, `rompues : ${brokenChains.join(" ; ")}`);
  else ok("chaînes de hash du grand livre", `${entriesChecked} écriture(s) sur ${journalsChecked} journal/journaux`, "chaque hash et chaque numéro se recalculent");

  // --- 5 : chaîne de la piste d'audit --------------------------------------
  // Deux contrôles distincts : le chaînage (prev_hash = hash précédent) et le
  // recalcul du digest lui-même. Le second dépend du rendu textuel de `at`,
  // donc du fuseau de session : on réessaie sous UTC avant de conclure.
  const auditTotal = Number(await psqlValue(drillUrl, "SELECT count(*) FROM audit_log"));
  if (auditTotal === 0) {
    skip("chaîne de la piste d'audit", "aucune ligne d'audit dans la sauvegarde.");
  } else {
    const probe = async (timezone: string | null) =>
      (
        await psqlValue(
          drillUrl,
          `${timezone ? `SET TimeZone = '${timezone}'; ` : ""}SELECT count(*) FILTER (WHERE prev_hash IS DISTINCT FROM expected_prev) || '/' || count(*) FILTER (WHERE hash <> expected_hash)
             FROM (SELECT hash, prev_hash, lag(hash) OVER w AS expected_prev,
                          encode(digest(coalesce(lag(hash) OVER w, 'GENESIS') || '|' || tenant_id::text || '|' || coalesce(user_id::text, '') || '|' ||
                                        action || '|' || entity || '|' || entity_id || '|' || coalesce(before::text, '') || '|' ||
                                        coalesce(after::text, '') || '|' || at::text, 'sha256'), 'hex') AS expected_hash
                     FROM audit_log WINDOW w AS (PARTITION BY tenant_id ORDER BY id)) x`,
        )
      )
        .split("/")
        .map(Number);
    let [linkBroken, digestBroken] = await probe(null);
    if (digestBroken !== 0) [linkBroken, digestBroken] = await probe("UTC");
    if (linkBroken !== 0) ko("chaîne de la piste d'audit", `${auditTotal} ligne(s)`, `${linkBroken} rupture(s) de chaînage`);
    else if (digestBroken !== 0) ko("chaîne de la piste d'audit", `${auditTotal} ligne(s)`, `chaînage intact, mais ${digestBroken} hash ne se recalculent pas`);
    else ok("chaîne de la piste d'audit", `${auditTotal} ligne(s)`, "chaînage et hash recalculés à l'identique");
  }

  // --- 6 : chaîne d'ancres --------------------------------------------------
  let anchorsChecked = 0;
  let unpublished = 0;
  const anchorProblems: string[] = [];
  for (const company of companies) {
    const service = new AnchoringService({ store: new PostgresAnchorStore(db as unknown as Sql, { organizationId: company.organization_id }), publisher: null });
    const report = await service.verifyChain(company.id);
    anchorsChecked += report.anchors;
    unpublished += report.unpublished.length;
    if (!report.chain.ok) anchorProblems.push(`${company.name} : chaîne rompue au ${report.chain.brokenAt}`);
    if (report.tampered.length > 0) anchorProblems.push(`${company.name} : racine non recalculable pour ${report.tampered.join(", ")}`);
  }
  if (anchorsChecked === 0) {
    skip("chaîne d'ancres", "aucune ancre dans cette sauvegarde : l'ancrage externe n'était pas en service (ANCHOR_PUBLISHER).");
  } else if (anchorProblems.length > 0) {
    ko("chaîne d'ancres", `${anchorsChecked} ancre(s)`, anchorProblems.join(" ; "));
  } else {
    ok("chaîne d'ancres", `${anchorsChecked} ancre(s)`, `chaînage intact et chaque racine de Merkle recalculée depuis les données restaurées${unpublished > 0 ? ` (dont ${unpublished} jamais publiée(s))` : ""}`);
  }

  // --- 7 : soldes ------------------------------------------------------------
  const balances = Number(await psqlValue(drillUrl, "SELECT count(*) FROM account_balance"));
  if (balances === 0) {
    skip("soldes par compte et période", "aucun solde dans la sauvegarde.");
  } else {
    const gaps = Number(
      await psqlValue(
        drillUrl,
        `WITH recomputed AS (
           SELECT e.tenant_id, l.account_id, e.period_id, sum(l.debit_base) AS debit, sum(l.credit_base) AS credit
             FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
            WHERE e.status = 'VALIDATED' GROUP BY 1, 2, 3)
         SELECT count(*) FROM recomputed r FULL JOIN account_balance b USING (tenant_id, account_id, period_id)
          WHERE coalesce(r.debit, 0) <> coalesce(b.debit, 0) OR coalesce(r.credit, 0) <> coalesce(b.credit, 0)`,
      ),
    );
    if (gaps > 0) ko("soldes par compte et période", `${balances} solde(s)`, `${gaps} écart(s) avec le recalcul depuis les lignes`);
    else ok("soldes par compte et période", `${balances} solde(s)`, "identiques au recalcul depuis les lignes d'écriture");
  }
} finally {
  await db?.end();
}

// --- rapport ----------------------------------------------------------------
failures += checks.filter((c) => c.status === "ÉCHEC").length;
const skipped = checks.filter((c) => c.status === "IGNORÉ").length;

console.log("");
console.log("  Contrôle                             État     Portée");
console.log("  " + "-".repeat(94));
for (const c of checks) {
  const mark = c.status === "OK" ? "✓ OK    " : c.status === "ÉCHEC" ? "✗ ÉCHEC " : "· IGNORÉ";
  console.log(`  ${c.name.padEnd(36)} ${mark} ${c.examined}`);
  if (c.detail) console.log(`  ${" ".repeat(36)}          ${c.detail}`);
}
console.log("");

if (failures > 0) {
  console.error(`✗ exercice en échec : ${failures} contrôle(s) rouge(s). La base d'exercice « ${drillDb} » est conservée pour l'autopsie.`);
  console.error(`  Inspection : psql ${maskUrl(drillUrl)}`);
  console.error(`  Suppression : psql <service> -c 'DROP DATABASE "${drillDb}" WITH (FORCE)'`);
  process.exit(1);
}

console.log(`✓ exercice réussi : ${checks.length - skipped} contrôle(s) passé(s)${skipped > 0 ? `, ${skipped} sans objet` : ""}.`);
if (skipped > 0) console.log("  Un contrôle « IGNORÉ » n'a rien vérifié : lisez sa raison plutôt que de la compter comme un succès.");

if (flag(argv, "keep")) {
  console.log(`  Base d'exercice conservée (--keep) : ${drillDb}`);
} else {
  const dropped = await run("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE "${drillDb}" WITH (FORCE)`]);
  if (dropped.code !== 0) console.error(`  ! base d'exercice « ${drillDb} » non supprimée : ${dropped.stderr.trim()}`);
  else console.log(`  Base d'exercice supprimée.`);
}
console.log("");
console.log("À consigner dans le registre d'exploitation : date, archive éprouvée, durée, et ce rapport.");
