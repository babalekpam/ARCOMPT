/**
 * Restauration d'une archive ARCOMPT sur une base cible.
 *
 *   # exercice : la cible s'annonce jetable, rien d'autre à faire
 *   BACKUP_ENCRYPTION_KEY=… pnpm exec tsx scripts/restore.mts \
 *     --file backups/arcompt-2025-03-04T02-00-00Z.sql.gz.enc \
 *     --target postgres://arcompt@localhost:5432/arcompt_drill_20250304
 *
 *   # vraie reprise sur une base qui n'est pas jetable : deux gestes exigés
 *   ALLOW_DESTRUCTIVE_RESTORE=1 BACKUP_ENCRYPTION_KEY=… pnpm exec tsx scripts/restore.mts \
 *     --file … --target postgres://…/arcompt --confirm arcompt --reset
 *
 * Le danger de ce script n'est pas de rater : c'est de **réussir sur la
 * mauvaise base**. Une commande juste, lancée avec le `DATABASE_URL` de
 * production encore dans le terminal, détruit dix ans d'écritures sans rien
 * afficher d'anormal. Trois refus, dans cet ordre :
 *
 *   1. la cible n'est pas nommée : `--target` est obligatoire, `DATABASE_URL`
 *      n'est jamais pris par défaut ;
 *   2. le nom de la cible n'annonce pas une base jetable : il faut retaper ce
 *      nom (`--confirm`) **et** poser `ALLOW_DESTRUCTIVE_RESTORE=1` ;
 *   3. la cible contient déjà des dossiers : il faut `--reset`.
 *
 * Options :
 *   --file <archive>     archive chiffrée à restaurer (obligatoire)
 *   --target <url>       base cible (obligatoire)
 *   --confirm <base>     nom exact de la cible, exigé hors base jetable
 *   --reset              vide le schéma public de la cible avant restauration
 *   --skip-verify        ne pas confronter l'archive à son manifeste (déconseillé)
 */

import { arg, assertWritableTarget, DestructiveRefusal, fail, flag, maskUrl, parseTarget, psqlValue } from "./lib/pg.mts";
import { masterKey, readArchiveHeader } from "./lib/backup-archive.mts";
import { restoreArchive, RestoreError } from "./lib/restore-core.mts";

const argv = process.argv.slice(2);

const file = arg(argv, "file");
const targetUrl = arg(argv, "target");
if (!file) fail("--file <archive> est obligatoire.");
if (!targetUrl) fail("--target <url> est obligatoire : ce script ne devine jamais la cible depuis DATABASE_URL.");

const key = (() => {
  try {
    return masterKey();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();

const target = parseTarget(targetUrl);
try {
  assertWritableTarget({ target, confirm: arg(argv, "confirm") });
} catch (e) {
  if (e instanceof DestructiveRefusal) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const header = await readArchiveHeader(file).catch((e: Error) => fail(e.message));

console.log(`Restauration de ${file}`);
console.log(`  archive      : ${header.header.database}@${header.header.host}, prise le ${header.header.createdAt}`);
console.log(`  cible        : ${maskUrl(targetUrl)}${target.scratch ? " (base jetable)" : " (base NON jetable — confirmation fournie)"}`);

// Troisième garde-fou, indépendant du nom : une cible qui contient déjà des
// dossiers n'est pas une cible vide. `--reset` est l'aveu explicite.
const existing = await psqlValue(targetUrl, "SELECT count(*) FROM company").catch(() => "");
if (existing !== "" && Number(existing) > 0 && !flag(argv, "reset")) {
  fail(`la base « ${target.database} » contient déjà ${existing} dossier(s). Ajoutez --reset pour la vider d'abord, ou visez une autre base.`);
}

try {
  const outcome = await restoreArchive({
    file,
    targetUrl,
    key,
    reset: flag(argv, "reset"),
    skipManifest: flag(argv, "skip-verify"),
    log: (m) => console.log(`  → ${m}`),
  });

  console.log("");
  console.log(`✓ restauré sur ${target.database} : ${outcome.migrations} migration(s), ${Object.entries(outcome.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  if (outcome.drift.length > 0) {
    for (const d of outcome.drift) console.error(`  ✗ ${d.table} : ${d.restored ?? "?"} restauré(s) pour ${d.expected} sauvegardé(s)`);
    fail("les décomptes ne concordent pas avec le manifeste : la restauration est incomplète, ne mettez pas cette base en service.");
  }
  if (outcome.manifest) console.log("  ✓ décomptes identiques à ceux de la sauvegarde");
  else console.log("  ! manifeste non vérifié (--skip-verify) : rien ne garantit l'origine de ce que vous venez de restaurer.");

  console.log("");
  console.log("Une restauration qui s'exécute n'est pas une restauration valide : lancez");
  console.log(`  pnpm exec tsx scripts/restore-drill.mts --file ${file}`);
  console.log("pour vérifier les chaînes de hash et la chaîne d'ancres sur une base restaurée.");
} catch (e) {
  if (e instanceof RestoreError) fail(e.message);
  throw e;
}
