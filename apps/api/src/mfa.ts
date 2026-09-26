import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";
import { Hono } from "hono";
import type { AuthContext } from "./auth.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[19]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
export function matchingStep(secret: Buffer, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}
const hash = (purpose: string, value: string) => createHash("sha256").update(`arcompt:mfa:${purpose}:v1\0${value}`).digest("hex");
function key(): Buffer {
  // No deterministic development fallback: enrollment must remain decryptable
  // after restarts and must never depend on a public/dev signing key.
  const encoded = process.env.PAYROLL_ENCRYPTION_KEY;
  const master = Buffer.from(encoded ?? "", "base64");
  if (master.length !== 32 || master.toString("base64") !== encoded) throw new Error("MFA_KEY_UNAVAILABLE");
  return Buffer.from(hkdfSync("sha256", master, "ARCOMPT", "authenticator-mfa:v1", 32));
}
export function encryptMfa(secret: Buffer, sub: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`arcompt:mfa:v1:${sub}`));
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decryptMfa(value: string, sub: string): Buffer {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(`arcompt:mfa:v1:${sub}`));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}
export async function mfaStatus(db: Sql, sub: string, sid: string, proof?: string) {
  const digest = proof && /^[A-Za-z0-9_-]{43}$/.test(proof) ? hash("proof", proof) : "";
  const [row] = await db`SELECT * FROM app_mfa_status(${sub}, ${sid}, ${digest})`;
  return { enabled: row?.enabled === true, verified: Boolean(row?.expires_at),
    ...(row?.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}) };
}
export function mfaRoutes(db?: Sql) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!db) return c.json({ error: { code: "MFA_UNAVAILABLE", message: "Authentification indisponible" } }, 503);
    if (!c.get("auth").mfaIdentity) return c.json({ error: { code: "UNAUTHORIZED", message: "Session Clerk vérifiée requise" } }, 401);
    await next();
  });
  app.get("/status", async (c) => {
    const { sub, sid } = c.get("auth").mfaIdentity!;
    return c.json(await mfaStatus(db!, sub, sid, c.req.header("x-arcompt-mfa")));
  });
  app.post("/:action", async (c) => {
    const action = c.req.param("action");
    if (!["enroll", "confirm", "verify", "recovery-codes"].includes(action)) return c.notFound();
    const { sub, sid, email } = c.get("auth").mfaIdentity!;
    const failed = () => c.json({ error: { code: "MFA_INVALID", message: "Vérification impossible. Réessayez avec un nouveau code." } }, 400);
    // This statement commits independently: bad codes and thrown exceptions
    // cannot roll back the persistent subject-wide rate limit.
    const [budget] = await db!`SELECT app_mfa_attempt(${sub}) AS allowed`;
    if (!budget?.allowed) return c.json({ error: { code: "MFA_RATE_LIMITED", message: "Réessayez ultérieurement." } }, 429);
    try {
      if (action === "enroll") {
        const raw = randomBytes(20), secret = base32(raw);
        const cipher = encryptMfa(raw, sub);
        const [row] = await db!`SELECT app_mfa_enroll(${sub}, ${cipher}) AS expires_at`;
        if (!row?.expires_at) return failed();
        return c.json({ secret, otpauthUri: `otpauth://totp/${encodeURIComponent(`ARCOMPT:${email}`)}?secret=${secret}&issuer=ARCOMPT&algorithm=SHA1&digits=6&period=30`,
          expiresAt: new Date(row.expires_at).toISOString() });
      }
      const body = await c.req.json().catch(() => null) as { code?: unknown } | null;
      if (typeof body?.code !== "string" || body.code.length > 64) return failed();
      const code = body.code.trim();
      const result = await db!.begin(async (tx) => {
        const [factor] = await tx`SELECT * FROM app_mfa_lock(${sub})`;
        if (!factor?.secret_cipher) return null;
        const step = matchingStep(decryptMfa(String(factor.secret_cipher), sub), code);
        const recovery = /^[a-f0-9]{24}$/.test(code.replaceAll("-", "").toLowerCase())
          ? hash("recovery", `${sub}\0${code.replaceAll("-", "").toLowerCase()}`) : null;
        if (step === null && (action !== "verify" || !recovery)) return null;
        const recoveryCodes = action === "confirm" || action === "recovery-codes"
          ? Array.from({ length: 10 }, () => randomBytes(12).toString("hex")) : [];
        const hashes = recoveryCodes.map((v) => hash("recovery", `${sub}\0${v}`));
        const proof = randomBytes(32).toString("base64url");
        const [row] = await tx`SELECT app_mfa_complete(${sub}, ${sid}, ${String(factor.secret_cipher)},
          ${step}, ${recovery}, ${hash("proof", proof)}, ${hashes}::text[], ${action}) AS expires_at`;
        if (!row?.expires_at) return null;
        return action === "recovery-codes" ? { recoveryCodes } : {
          proof, expiresAt: new Date(row.expires_at).toISOString(),
          ...(action === "confirm" ? { recoveryCodes } : {}),
        };
      });
      return result ? c.json(result) : failed();
    } catch {
      // Neither codes, ciphertext, secrets nor driver queries enter logs.
      return c.json({ error: { code: "MFA_UNAVAILABLE", message: "Authentification indisponible" } }, 503);
    }
  });
  return app;
}