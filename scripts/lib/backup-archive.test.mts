import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptArchive,
  masterKey,
  manifestPath,
  readArchiveHeader,
  readManifest,
  writeArchive,
  writeManifest,
  type BackupManifest,
} from "./backup-archive.mts";
import { assertWritableTarget, DestructiveRefusal, parseTarget, SCRATCH_PATTERN } from "./pg.mts";

/**
 * Format d'archive de sauvegarde : ce que le fichier doit garantir.
 *
 * Trois propriétés, et rien d'autre ne compte le jour de la reprise : le
 * contenu revient **identique**, une archive touchée **refuse** de se
 * déchiffrer plutôt que de rendre un SQL partiel, et un manifeste retouché est
 * **démasqué**.
 */
const KEY = randomBytes(32).toString("base64");
const SQL = `-- dump de démonstration\n${"INSERT INTO journal_entry VALUES ('x');\n".repeat(500)}`;

let dir: string;
const key = masterKey({ BACKUP_ENCRYPTION_KEY: KEY });

const collect = (chunks: Buffer[]) => new Writable({ write: (c: Buffer, _e, cb) => (chunks.push(Buffer.from(c)), cb()) });

async function makeArchive(name: string, content = SQL): Promise<string> {
  const path = join(dir, name);
  await writeArchive(Readable.from([Buffer.from(content, "utf8")]), path, key, { database: "arcompt", host: "db.example.org" });
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcompt-backup-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("archive de sauvegarde", () => {
  it("rend exactement ce qui a été sauvegardé", async () => {
    const path = await makeArchive("aller-retour.sql.gz.enc");
    const chunks: Buffer[] = [];
    const result = await decryptArchive(path, key, collect(chunks));
    expect(Buffer.concat(chunks).toString("utf8")).toBe(SQL);
    expect(result.plaintextBytes).toBe(Buffer.byteLength(SQL));
  });

  it("chiffre réellement : le SQL n'apparaît nulle part dans le fichier", async () => {
    const path = await makeArchive("chiffre.sql.gz.enc");
    const raw = await readFile(path);
    expect(raw.toString("latin1")).not.toContain("journal_entry");
    // L'en-tête, lui, reste lisible : il faut pouvoir dire d'où vient une archive sans la clé.
    expect((await readArchiveHeader(path)).header.database).toBe("arcompt");
  });

  it("refuse de se déchiffrer si un seul octet a bougé", async () => {
    const path = await makeArchive("altere.sql.gz.enc");
    const raw = await readFile(path);
    raw[raw.length - 200] ^= 0x01;
    await writeFile(path, raw);
    await expect(decryptArchive(path, key, collect([]))).rejects.toThrow();
  });

  it("refuse une archive dont l'en-tête a été maquillé", async () => {
    const path = await makeArchive("entete.sql.gz.enc");
    const raw = await readFile(path);
    // L'en-tête sert de données associées au chiffre : le réécrire invalide le sceau.
    await writeFile(path, Buffer.from(raw.toString("latin1").replace('"database":"arcompt"', '"database":"autre__"'), "latin1"));
    await expect(decryptArchive(path, key, collect([]))).rejects.toThrow();
  });

  it("refuse une archive tronquée avant d'en restaurer la moindre ligne", async () => {
    const path = await makeArchive("tronquee.sql.gz.enc");
    const raw = await readFile(path);
    await writeFile(path, raw.subarray(0, raw.length - 4000));
    await expect(decryptArchive(path, key, collect([]))).rejects.toThrow();
  });

  it("ne s'ouvre pas avec une autre clé", async () => {
    const path = await makeArchive("autre-cle.sql.gz.enc");
    const other = masterKey({ BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
    await expect(decryptArchive(path, other, collect([]))).rejects.toThrow();
  });

  it("refuse un fichier qui n'est pas une archive ARCOMPT", async () => {
    const path = join(dir, "pas-une-archive.sql.gz.enc");
    await writeFile(path, "ceci est un dump en clair");
    await expect(readArchiveHeader(path)).rejects.toThrow(/magie absente/);
  });

  it("exige une clé de 32 octets, et n'accepte aucun repli en clair", () => {
    expect(() => masterKey({})).toThrow(/BACKUP_ENCRYPTION_KEY absente/);
    expect(() => masterKey({ BACKUP_ENCRYPTION_KEY: "dHJvcCBjb3VydA==" })).toThrow(/32 octets/);
  });
});

describe("manifeste", () => {
  const base = (file: string): BackupManifest => ({
    file,
    header: { version: 1, cipher: "aes-256-gcm", compression: "gzip", salt: randomBytes(32).toString("base64"), iv: randomBytes(12).toString("base64"), createdAt: new Date().toISOString(), database: "arcompt", host: "db" },
    sha256Ciphertext: "a".repeat(64),
    ciphertextBytes: 10,
    sha256Plaintext: "b".repeat(64),
    plaintextBytes: 20,
    migrations: ["0001_core.sql"],
    counts: { journal_entry: 42 },
    pgDumpVersion: "pg_dump (PostgreSQL) 16.13",
  });

  it("se relit tel qu'il a été scellé", async () => {
    const archive = join(dir, "manifeste-ok.sql.gz.enc");
    await writeManifest(archive, base("manifeste-ok.sql.gz.enc"), key);
    expect((await readManifest(archive, key)).counts.journal_entry).toBe(42);
  });

  it("démasque un décompte retouché à la main", async () => {
    const archive = join(dir, "manifeste-truque.sql.gz.enc");
    await writeManifest(archive, base("manifeste-truque.sql.gz.enc"), key);
    const path = manifestPath(archive);
    const manifest = JSON.parse(await readFile(path, "utf8")) as BackupManifest;
    manifest.counts.journal_entry = 41;
    await writeFile(path, JSON.stringify(manifest));
    await expect(readManifest(archive, key)).rejects.toThrow(/sceau HMAC invalide/);
  });

  it("refuse un manifeste sans sceau", async () => {
    const archive = join(dir, "manifeste-nu.sql.gz.enc");
    await writeFile(manifestPath(archive), JSON.stringify(base("manifeste-nu.sql.gz.enc")));
    await expect(readManifest(archive, key)).rejects.toThrow(/sans sceau/);
  });
});

describe("garde-fou de restauration", () => {
  const target = (url: string) => parseTarget(url);

  it("reconnaît une base jetable à son nom, et seulement à ce motif", () => {
    for (const name of ["arcompt_drill_20250304", "arcompt_test", "scratch_arcompt", "arcompt_restore_1", "arcompt-sandbox"]) {
      expect(SCRATCH_PATTERN.test(name)).toBe(true);
    }
    for (const name of ["arcompt", "arcompt_prod", "arcompt_2025", "comptabilite"]) {
      expect(SCRATCH_PATTERN.test(name)).toBe(false);
    }
  });

  it("laisse passer une cible jetable sans cérémonie", () => {
    expect(assertWritableTarget({ target: target("postgres://u@h:5432/arcompt_drill_1"), env: {} })).toEqual({ scratch: true });
  });

  it("refuse une base de production, et le dit en nommant les deux gestes manquants", () => {
    expect(() => assertWritableTarget({ target: target("postgres://u@h:5432/arcompt"), env: {} })).toThrow(DestructiveRefusal);
    try {
      assertWritableTarget({ target: target("postgres://u@h:5432/arcompt"), env: {} });
    } catch (e) {
      expect((e as Error).message).toMatch(/ALLOW_DESTRUCTIVE_RESTORE/);
      expect((e as Error).message).toMatch(/--confirm/);
    }
  });

  it("exige les deux gestes : ni la variable seule, ni la confirmation seule ne suffisent", () => {
    const t = target("postgres://u@h:5432/arcompt");
    expect(() => assertWritableTarget({ target: t, env: { ALLOW_DESTRUCTIVE_RESTORE: "1" } })).toThrow(DestructiveRefusal);
    expect(() => assertWritableTarget({ target: t, confirm: "arcompt", env: {} })).toThrow(DestructiveRefusal);
    expect(() => assertWritableTarget({ target: t, confirm: "arcompt_autre", env: { ALLOW_DESTRUCTIVE_RESTORE: "1" } })).toThrow(DestructiveRefusal);
    expect(assertWritableTarget({ target: t, confirm: "arcompt", env: { ALLOW_DESTRUCTIVE_RESTORE: "1" } })).toEqual({ scratch: false });
  });
});
