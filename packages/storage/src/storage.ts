// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Stockage de fichiers (pièces justificatives, PDF, exports).
 *
 * Deux adaptateurs : système de fichiers local (développement, tests) et
 * Cloudflare R2 via l'API S3 (production). Les clés sont des chemins
 * relatifs (`tenant/<uuid>/facture.pdf`) ; elles sont assainies avant tout
 * accès disque pour interdire toute sortie du répertoire racine.
 */
export interface PutOptions {
  contentType: string;
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface Storage {
  put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<void>;
  /** Renvoie null si la clé n'existe pas. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** URL de téléchargement temporaire (ttl en secondes). */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export class StorageError extends Error {
  override name = "StorageError";
  constructor(
    readonly code: "INVALID_KEY" | "NOT_FOUND" | "CONFIG",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Assainit une clé : segments non vides, pas de `..`, pas de chemin absolu,
 * caractères limités à [A-Za-z0-9._-]. Les autres caractères sont remplacés
 * par `_`. Lève StorageError si la clé est vide ou tente de remonter.
 */
export function sanitizeKey(key: string): string {
  const raw = key.replace(/\\/g, "/").trim();
  if (raw === "" || raw.startsWith("/")) throw new StorageError("INVALID_KEY", `Clé de stockage invalide : "${key}"`);
  const segments = raw.split("/").filter((s) => s !== "");
  if (segments.length === 0) throw new StorageError("INVALID_KEY", `Clé de stockage vide`);
  const clean = segments.map((s) => {
    if (s === "." || s === "..") throw new StorageError("INVALID_KEY", `Clé de stockage interdite : "${key}"`);
    const safe = s.replace(/[^A-Za-z0-9._-]/g, "_");
    if (/^\.+$/.test(safe)) throw new StorageError("INVALID_KEY", `Clé de stockage interdite : "${key}"`);
    return safe;
  });
  return clean.join("/");
}
