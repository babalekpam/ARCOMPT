// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sanitizeKey, StorageError, type PutOptions, type Storage, type StoredObject } from "./storage.js";

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Surcharge du point d'accès (tests, autre fournisseur S3). */
  endpoint?: string;
}

/** Cloudflare R2 via l'API S3. Les pièces sont conservées 10 ans (AUDCIF) : aucune purge automatique ici. */
export class R2Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: R2Options, client?: S3Client) {
    this.bucket = opts.bucket;
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint: opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      });
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key), Body: bytes, ContentType: opts.contentType }));
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }));
      const bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
      return { bytes, contentType: res.ContentType ?? "application/octet-stream" };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }));
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }), { expiresIn: ttlSeconds });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

/** Construit le stockage R2 depuis l'environnement ; lève StorageError si une variable manque. */
export function r2OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): R2Options | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID && !R2_ACCESS_KEY_ID && !R2_SECRET_ACCESS_KEY) return null;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new StorageError("CONFIG", "R2 : R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY et R2_BUCKET sont tous requis");
  }
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET };
}
