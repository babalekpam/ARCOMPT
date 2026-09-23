/**
 * Sauvegarde chiffrée et vérifiable d'une base ARCOMPT.
 *
 *   BACKUP_ENCRYPTION_KEY='<base64 de 32 octets>' \
 *   DATABASE_URL=postgres://<compte_de_sauvegarde>@… \
 *   pnpm exec tsx scripts/backup.mts --out /var/backups/arcompt
 *
 *   # contrôle d'une archive existante, sans rien restaurer
 *   BACKUP_ENCRYPTION_KEY=… pnpm exec tsx scripts/backup.mts --verify /var/backups/arcompt/arcompt-2025-03-04T02-00-00Z.sql.gz.enc
 *
 * Ce que « vérifiable » veut dire ici, et pourquoi ce n'est pas un détail. Une
 * sauvegarde qu'on n'a jamais relue n'est pas une sauvegarde : c'est un fichier.
 * Le script produit donc, à côté de l'archive, un manifeste scellé (HMAC) qui
 * porte l'empreinte du chiffré, l'empreinte du SQL en clair, la liste des
 * migrations appliquées et des décomptes de référence. `--verify` relit
 * l'archive de bout en bout et confronte les trois. `restore-drill.mts`
 * confronte en plus les décomptes après restauration réelle.
 *
 * Options :
 *   --out <répertoire>   où déposer l'archive (défaut : ./backups)
 *   --url <url>          base à sauvegarder (défaut : DATABASE_URL)
 *   --label <texte>      suffixe de nom de fichier (ex. « avant-migration »)
 *   --verify <fichier>   ne sauvegarde rien : relit et contrôle une archive
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { arg, fail, maskUrl, parseTarget, psqlValue, run } from "./lib/pg.mts";
import { decryptArchive, masterKey, readArchiveHeader, readManifest, writeArchive, writeManifest, type BackupManifest } from "./lib/backup-archive.mts";

/** Tables dont le décompte sert de témoin après restauration. */
const WITNESS_TABLES = ["company", "journal_entry", "journal_line", "audit_log", "ledger_anchor", "period", "partner"];

const argv = process.argv.slice(2);
const key = (() => {
  try {
    return masterKey();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();

// ---------------------------------------------------------------------------
// Vérification d'une archive existante
// ---------------------------------------------------------------------------
const toVerify = arg(argv, "verify");
if (toVerify) {
  const info = await readArchiveHeader(toVerify).catch((e: Error) => fail(e.message));
  const manifest = await readManifest(toVerify, key).catch((e: Error) => fail(e.message));

  console.log(`Archive   : ${toVerify}`);
  console.log(`  origine : ${info.header.database} sur ${info.header.host}, ${info.header.createdAt}`);
  console.log(`  taille  : ${info.fileBytes} octets (dont ${info.bodyLength} chiffrés)`);

  // Déchiffrement complet vers /dev/null : c'est le sceau GCM et l'empreinte du
  // clair qui prouvent que l'archive est lisible, pas sa seule présence.
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const result = await decryptArchive(toVerify, key, sink).catch((e: Error) =>
    fail(`déchiffrement impossible — archive altérée, tronquée, ou clé différente de celle de la sauvegarde (${e.message})`),
  );

  const checks: Array<[string, boolean, string]> = [
    ["sceau AES-GCM", true, "l'archive s'est déchiffrée entièrement"],
    ["empreinte du chiffré", result.sha256Ciphertext === manifest.sha256Ciphertext, `${result.sha256Ciphertext.slice(0, 16)}… vs manifeste ${manifest.sha256Ciphertext.slice(0, 16)}…`],
    ["empreinte du clair", result.sha256Plaintext === manifest.sha256Plaintext, `${result.plaintextBytes} octets de SQL`],
    ["taille du clair", result.plaintextBytes === manifest.plaintextBytes, `${result.plaintextBytes} vs ${manifest.plaintextBytes}`],
    ["sceau du manifeste", true, "HMAC vérifié à la lecture"],
  ];
  console.log("");
  for (const [name, ok, detail] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(22)} ${detail}`);
  console.log("");
  console.log(`  migrations : ${manifest.migrations.length} (${manifest.migrations.at(-1) ?? "aucune"})`);
  console.log(`  témoins    : ${Object.entries(manifest.counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);

  if (checks.some(([, ok]) => !ok)) fail("archive incohérente avec son manifeste : ne comptez pas dessus pour une reprise.");
  console.log("");
  console.log("✓ archive lisible et conforme à son manifeste.");
  console.log("  Cela ne prouve pas encore qu'elle se restaure : c'est l'objet de scripts/restore-drill.mts.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Sauvegarde
// ---------------------------------------------------------------------------
const url = arg(argv, "url") ?? process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL absent (ou --url) : rien à sauvegarder.");
const target = parseTarget(url);
const outDir = arg(argv, "out") ?? "backups";
const label = arg(argv, "label");

const version = await run("pg_dump", ["--version"]);
if (version.code !== 0) fail(`pg_dump indisponible : ${version.stderr.trim()}`);
const pgDumpVersion = version.stdout.trim();

// Relevés pris AVANT le dump : ils décrivent la base telle qu'on la sauvegarde,
// et serviront de témoins à la restauration.
const migrations = (await psqlValue(url, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migration").catch(() => ""))
  .split(",")
  .filter((m) => m !== "");
if (migrations.length === 0) fail("aucune migration trouvée sur cette base : ce n'est pas un schéma ARCOMPT, ou le compte n'a pas le droit de lire schema_migration.");

const counts: Record<string, number> = {};
for (const table of WITNESS_TABLES) {
  const value = await psqlValue(url, `SELECT count(*) FROM ${table}`).catch(() => "");
  if (value !== "") counts[table] = Number(value);
}

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
const fileName = `${target.database}-${stamp}${label ? `-${label.replace(/[^\w.-]+/g, "_")}` : ""}.sql.gz.enc`;
const archivePath = join(outDir, fileName);

console.log(`Sauvegarde de ${maskUrl(url)}`);
console.log(`  → ${archivePath}`);

// `--no-owner --no-privileges` est délibérément ABSENT : les droits font partie
// de ce que l'on doit pouvoir restaurer et vérifier (SECURITY.md § 6, modèle de
// droits du rôle applicatif). Une restauration sur un autre cluster doit donc
// créer les rôles d'abord — c'est documenté dans OPERATIONS.md.
const dump = spawn("pg_dump", ["--format=plain", "--no-sync", "--quote-all-identifiers", url], { stdio: ["ignore", "pipe", "pipe"] });
let dumpError = "";
dump.stderr.on("data", (d: Buffer) => (dumpError += d.toString()));
const dumpExit = new Promise<number>((resolve) => dump.on("close", (code) => resolve(code ?? -1)));

const written = await writeArchive(dump.stdout, archivePath, key, { database: target.database, host: target.host }).catch((e: Error) =>
  fail(`écriture de l'archive impossible : ${e.message}`),
);
const code = await dumpExit;
if (code !== 0) fail(`pg_dump a échoué (code ${code}) : ${dumpError.trim()}`);

const manifest: BackupManifest = {
  file: fileName,
  header: written.header,
  sha256Ciphertext: written.sha256Ciphertext,
  ciphertextBytes: written.ciphertextBytes,
  sha256Plaintext: written.sha256Plaintext,
  plaintextBytes: written.plaintextBytes,
  migrations,
  counts,
  pgDumpVersion,
};
const manifestFile = await writeManifest(archivePath, manifest, key);

console.log("");
console.log(`✓ archive       : ${archivePath} (${written.ciphertextBytes} octets chiffrés)`);
console.log(`  manifeste     : ${manifestFile}`);
console.log(`  SQL en clair  : ${written.plaintextBytes} octets, sha256 ${written.sha256Plaintext.slice(0, 16)}…`);
console.log(`  migrations    : ${migrations.length}, la dernière étant ${migrations.at(-1)}`);
console.log(`  témoins       : ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
console.log("");
console.log("À faire ensuite : copier l'archive ET son manifeste hors site, puis");
console.log("  pnpm exec tsx scripts/backup.mts --verify " + archivePath);
