// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Cœur de la restauration, partagé par `scripts/restore.mts` (à la main) et
 * `scripts/restore-drill.mts` (exercice). Un seul chemin de code : l'exercice
 * trimestriel doit éprouver exactement la procédure de reprise, sinon il
 * n'éprouve rien.
 *
 * Aucun garde-fou ici : c'est l'appelant qui décide si la cible est écrasable
 * (`assertWritableTarget`), pour que le refus arrive avant qu'une seule
 * commande n'ait été envoyée à la base.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psqlValue, run } from "./pg.mts";
import { decryptArchive, readManifest, type BackupManifest } from "./backup-archive.mts";

export interface RestoreOptions {
  file: string;
  targetUrl: string;
  key: Buffer;
  /** Vider le schéma public de la cible avant de restaurer. */
  reset?: boolean;
  /** Ne pas confronter l'archive à son manifeste (déconseillé, mais possible si le manifeste est perdu). */
  skipManifest?: boolean;
  log?: (message: string) => void;
}

export interface RestoreOutcome {
  manifest: BackupManifest | null;
  plaintextBytes: number;
  migrations: number;
  counts: Record<string, number>;
  /** Tables dont le décompte diffère de la sauvegarde. Vide = restauration complète. */
  drift: Array<{ table: string; expected: number; restored: number | null }>;
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

export async function restoreArchive(opts: RestoreOptions): Promise<RestoreOutcome> {
  const log = opts.log ?? (() => {});
  const manifest = opts.skipManifest ? null : await readManifest(opts.file, opts.key);

  if (opts.reset) {
    log("vidage du schéma public de la cible");
    const reset = await run("psql", [opts.targetUrl, "-v", "ON_ERROR_STOP=1", "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"]);
    if (reset.code !== 0) throw new RestoreError(`vidage impossible : ${reset.stderr.trim()}`);
  }

  // Le SQL est déchiffré vers un fichier temporaire à droits restreints plutôt
  // que tubé directement : psql doit pouvoir s'arrêter à la première erreur, et
  // un tube masquerait un déchiffrement interrompu en milieu de restauration.
  const workDir = await mkdtemp(join(tmpdir(), "arcompt-restore-"));
  const sqlPath = join(workDir, "dump.sql");
  try {
    const decrypted = await decryptArchive(opts.file, opts.key, createWriteStream(sqlPath, { mode: 0o600 })).catch((e: Error) => {
      throw new RestoreError(`déchiffrement impossible — archive altérée, tronquée, ou clé différente (${e.message})`);
    });
    if (manifest) {
      if (decrypted.sha256Ciphertext !== manifest.sha256Ciphertext) throw new RestoreError("le fichier chiffré ne correspond pas à l'empreinte du manifeste.");
      if (decrypted.sha256Plaintext !== manifest.sha256Plaintext) throw new RestoreError("le SQL déchiffré ne correspond pas à l'empreinte du manifeste.");
      log(`archive conforme au manifeste (${decrypted.plaintextBytes} octets de SQL)`);
    }

    log("exécution du SQL sur la cible");
    const restore = await run("psql", [opts.targetUrl, "-v", "ON_ERROR_STOP=1", "--quiet", "-f", sqlPath]);
    if (restore.code !== 0) {
      const tail = restore.stderr.trim().split("\n").slice(-10).join("\n  ");
      throw new RestoreError(`restauration interrompue (psql code ${restore.code}). La cible est dans un état partiel.\n  ${tail}`);
    }

    const migrations = Number(await psqlValue(opts.targetUrl, "SELECT count(*) FROM schema_migration").catch(() => "0"));
    const witnesses = Object.keys(manifest?.counts ?? { company: 0, journal_entry: 0, audit_log: 0, ledger_anchor: 0 });
    const counts: Record<string, number> = {};
    for (const table of witnesses) {
      const value = await psqlValue(opts.targetUrl, `SELECT count(*) FROM ${table}`).catch(() => "");
      if (value !== "") counts[table] = Number(value);
    }

    const drift = Object.entries(manifest?.counts ?? {})
      .filter(([table, expected]) => counts[table] !== expected)
      .map(([table, expected]) => ({ table, expected, restored: counts[table] ?? null }));

    return { manifest, plaintextBytes: decrypted.plaintextBytes, migrations, counts, drift };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
