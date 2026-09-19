import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Jetons d'invitation : 256 bits aléatoires encodés en base64url, transmis une
 * seule fois à l'invité. La base ne conserve que le hash SHA-256.
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Comparaison en temps constant de deux hashs hexadécimaux. */
export function tokenHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}
