/**
 * Format d'archive de sauvegarde ARCOMPT, et ce qu'il garantit.
 *
 * Une sauvegarde comptable doit résister à trois accidents, et la forme du
 * fichier découle de ces trois-là :
 *
 *  1. **Elle fuit.** Le fichier contient dix ans d'écritures, des salaires et
 *     des identifiants fiscaux. Il est donc chiffré (AES-256-GCM) avec une clé
 *     dérivée de `BACKUP_ENCRYPTION_KEY`, qui ne vit pas dans le dépôt. Sans la
 *     clé, le fichier n'est rien.
 *  2. **Elle s'abîme.** Un octet retourné sur une bande ou un transfert
 *     interrompu doit se voir *avant* le jour de la reprise. D'où le sceau GCM
 *     (qui refuse de déchiffrer une archive altérée) et l'empreinte sha256 du
 *     contenu en clair, conservée dans le manifeste.
 *  3. **On la truque.** Un manifeste en clair à côté de l'archive se réécrit à
 *     la main. Il porte donc un HMAC-SHA-256 sous une clé dérivée de la même
 *     clé maître : on ne peut pas maquiller une archive en une autre.
 *
 * Disposition du fichier :
 *
 *     "ARCOMPT-BACKUP-1\n"            magie, lisible par un humain avec `head -c 17`
 *     <4 octets> longueur d'en-tête   entier gros-boutiste
 *     <en-tête JSON>                  sel, IV, compression, base d'origine, date
 *     <chiffré>                       gzip(pg_dump), AES-256-GCM
 *     <16 octets>                     sceau GCM
 *
 * L'en-tête est **authentifié** : il sert de données associées (AAD) au chiffre,
 * donc changer le sel, l'IV ou le nom de la base d'origine fait échouer le
 * déchiffrement au lieu de produire une bouillie plausible.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export const MAGIC = Buffer.from("ARCOMPT-BACKUP-1\n", "utf8");
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 32;

export interface ArchiveHeader {
  version: 1;
  cipher: "aes-256-gcm";
  compression: "gzip";
  /** Sel de dérivation, base64 : une clé de données différente par archive. */
  salt: string;
  iv: string;
  createdAt: string;
  /** Base d'origine, pour qu'une restauration sache ce qu'elle restaure. */
  database: string;
  host: string;
}

export interface BackupManifest {
  file: string;
  header: ArchiveHeader;
  /** Empreinte du fichier chiffré : contrôle d'intégrité sans la clé. */
  sha256Ciphertext: string;
  ciphertextBytes: number;
  /** Empreinte du SQL en clair : contrôle de bout en bout, clé en main. */
  sha256Plaintext: string;
  plaintextBytes: number;
  /** Migrations appliquées sur la base d'origine : une restauration doit les retrouver toutes. */
  migrations: string[];
  /** Décomptes de référence, confrontés après restauration. */
  counts: Record<string, number>;
  pgDumpVersion: string;
  /** HMAC du manifeste sous une clé dérivée de la clé maître. */
  hmac?: string;
}

/** Clé maître depuis l'environnement. Absente, on ne sauvegarde pas — on ne sauvegarde jamais en clair. */
export function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.BACKUP_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY absente : une sauvegarde comptable en clair est un incident de sécurité, pas un repli. " +
        `Générez-la une fois (openssl rand -base64 ${KEY_BYTES}) et injectez-la depuis le gestionnaire de secrets.`,
    );
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`BACKUP_ENCRYPTION_KEY : base64 de ${KEY_BYTES} octets attendu (reçu ${key.length}).`);
  return key;
}

const derive = (master: Buffer, salt: Buffer, info: string): Buffer => Buffer.from(hkdfSync("sha256", master, salt, Buffer.from(info, "utf8"), KEY_BYTES));

/** Empreinte d'un flux, calculée au passage sans le mettre en mémoire. */
class HashTap extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error) => void) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    this.push(chunk);
    cb();
  }
}

export interface WriteArchiveResult {
  header: ArchiveHeader;
  sha256Plaintext: string;
  plaintextBytes: number;
  sha256Ciphertext: string;
  ciphertextBytes: number;
}

/**
 * Écrit l'archive : `source` (le SQL brut) est haché, compressé, chiffré, et le
 * sceau GCM est ajouté en fin de fichier. Rien n'est gardé en mémoire : une
 * base de plusieurs gigaoctets passe dans le même chemin.
 */
export async function writeArchive(source: Readable, path: string, master: Buffer, meta: { database: string; host: string }): Promise<WriteArchiveResult> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header: ArchiveHeader = {
    version: 1,
    cipher: "aes-256-gcm",
    compression: "gzip",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    createdAt: new Date().toISOString(),
    database: meta.database,
    host: meta.host,
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerJson.length);

  const cipher = createCipheriv("aes-256-gcm", derive(master, salt, "arcompt-backup-data-v1"), iv);
  cipher.setAAD(headerJson);

  const plain = new HashTap();
  const encrypted = new HashTap();
  const out = createWriteStream(path);
  out.write(Buffer.concat([MAGIC, headerLength, headerJson]));

  await pipeline(source, plain, createGzip({ level: 6 }), cipher, encrypted, out, { end: false });
  const tag = cipher.getAuthTag();
  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.end(tag, () => resolve());
  });

  return {
    header,
    sha256Plaintext: plain.hash.digest("hex"),
    plaintextBytes: plain.bytes,
    sha256Ciphertext: encrypted.hash.digest("hex"),
    ciphertextBytes: encrypted.bytes,
  };
}

export interface ReadArchive {
  header: ArchiveHeader;
  headerJson: Buffer;
  /** Décalage où commence le chiffré. */
  bodyStart: number;
  /** Taille du chiffré, sceau exclu. */
  bodyLength: number;
  tag: Buffer;
  fileBytes: number;
}

/** Lit l'en-tête et localise le corps. Une archive tronquée est refusée ici, pas au milieu d'une restauration. */
export async function readArchiveHeader(path: string): Promise<ReadArchive> {
  const fileBytes = (await stat(path)).size;
  const prefix = await readChunk(path, 0, MAGIC.length + 4);
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${path} n'est pas une archive ARCOMPT (magie absente).`);
  const headerLength = prefix.readUInt32BE(MAGIC.length);
  if (headerLength <= 0 || headerLength > 1 << 20) throw new Error(`${path} : en-tête de taille invalide (${headerLength}).`);
  const headerJson = await readChunk(path, MAGIC.length + 4, headerLength);
  const header = JSON.parse(headerJson.toString("utf8")) as ArchiveHeader;
  if (header.version !== 1 || header.cipher !== "aes-256-gcm") throw new Error(`${path} : format d'archive non pris en charge (${header.version}/${header.cipher}).`);
  const bodyStart = MAGIC.length + 4 + headerLength;
  const bodyLength = fileBytes - bodyStart - TAG_BYTES;
  if (bodyLength <= 0) throw new Error(`${path} : archive tronquée (aucun corps chiffré).`);
  const tag = await readChunk(path, fileBytes - TAG_BYTES, TAG_BYTES);
  return { header, headerJson, bodyStart, bodyLength, tag, fileBytes };
}

async function readChunk(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    if (bytesRead !== length) throw new Error(`${path} : lecture tronquée (${bytesRead}/${length} octets).`);
    return buf;
  } finally {
    await handle.close();
  }
}

export interface DecryptResult {
  sha256Plaintext: string;
  plaintextBytes: number;
  sha256Ciphertext: string;
}

/**
 * Déchiffre l'archive vers `sink`. Le sceau GCM est vérifié à la fin : si
 * l'archive a été modifiée d'un seul octet, l'opération **échoue** au lieu de
 * livrer un SQL partiellement correct — ce qui, pour une restauration, est bien
 * pire qu'un échec franc.
 */
export async function decryptArchive(path: string, master: Buffer, sink: NodeJS.WritableStream): Promise<DecryptResult> {
  const info = await readArchiveHeader(path);
  const decipher = createDecipheriv("aes-256-gcm", derive(master, Buffer.from(info.header.salt, "base64"), "arcompt-backup-data-v1"), Buffer.from(info.header.iv, "base64"));
  decipher.setAAD(info.headerJson);
  decipher.setAuthTag(info.tag);

  const encrypted = new HashTap();
  const plain = new HashTap();
  await pipeline(
    createReadStream(path, { start: info.bodyStart, end: info.bodyStart + info.bodyLength - 1 }),
    encrypted,
    decipher,
    createGunzip(),
    plain,
    sink,
  );
  return { sha256Plaintext: plain.hash.digest("hex"), plaintextBytes: plain.bytes, sha256Ciphertext: encrypted.hash.digest("hex") };
}

// ---------------------------------------------------------------------------
// Manifeste
// ---------------------------------------------------------------------------

export const manifestPath = (archivePath: string): string => `${archivePath}.manifest.json`;

function manifestHmac(manifest: BackupManifest, master: Buffer): string {
  const body: Omit<BackupManifest, "hmac"> = { ...manifest };
  delete (body as BackupManifest).hmac;
  const salt = Buffer.from(manifest.header.salt, "base64");
  return createHmac("sha256", derive(master, salt, "arcompt-backup-manifest-v1")).update(JSON.stringify(body)).digest("hex");
}

export async function writeManifest(archivePath: string, manifest: BackupManifest, master: Buffer): Promise<string> {
  const sealed: BackupManifest = { ...manifest, hmac: manifestHmac(manifest, master) };
  const path = manifestPath(archivePath);
  await writeFile(path, `${JSON.stringify(sealed, null, 2)}\n`, "utf8");
  return path;
}

/** Relit le manifeste et vérifie son sceau : un manifeste retouché est refusé. */
export async function readManifest(archivePath: string, master: Buffer): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(manifestPath(archivePath), "utf8")) as BackupManifest;
  if (!manifest.hmac) throw new Error(`${manifestPath(archivePath)} : manifeste sans sceau HMAC.`);
  const expected = Buffer.from(manifestHmac(manifest, master), "hex");
  const found = Buffer.from(manifest.hmac, "hex");
  if (expected.length !== found.length || !timingSafeEqual(expected, found)) {
    throw new Error(`${manifestPath(archivePath)} : sceau HMAC invalide — le manifeste ne correspond pas à cette clé ou a été modifié.`);
  }
  return manifest;
}
