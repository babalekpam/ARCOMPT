// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { sanitizeKey, StorageError, type PutOptions, type Storage, type StoredObject } from "./storage.js";

/**
 * Stockage local : un fichier par clé sous `STORAGE_DIR` (défaut ./.data/storage).
 * Le type MIME est conservé dans un fichier `<clé>.meta` à côté.
 */
export class LocalStorage implements Storage {
  readonly root: string;

  constructor(root?: string) {
    this.root = resolve(root ?? process.env.STORAGE_DIR ?? "./.data/storage");
  }

  private pathFor(key: string): string {
    const safe = sanitizeKey(key);
    const full = resolve(join(this.root, safe));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new StorageError("INVALID_KEY", `Clé hors du répertoire de stockage : "${key}"`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: opts.contentType }), "utf8");
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const bytes = await readFile(path);
      let contentType = "application/octet-stream";
      try {
        contentType = (JSON.parse(await readFile(`${path}.meta`, "utf8")) as { contentType?: string }).contentType ?? contentType;
      } catch {
        /* pas de méta : type par défaut */
      }
      return { bytes: new Uint8Array(bytes), contentType };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta`, { force: true });
  }

  /** En local il n'y a pas d'URL signée : on renvoie une URL `file://` (l'API sert les octets directement). */
  async signedUrl(key: string, _ttlSeconds: number): Promise<string> {
    const path = this.pathFor(key);
    if (!(await this.exists(key))) throw new StorageError("NOT_FOUND", `Objet introuvable : ${key}`);
    return `file://${path}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
