import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Sql } from "postgres";
import type { AuthContext } from "./auth.js";

export interface AdminModeEvidence { sid: string; tokenHash: string; proofHash: string }
export function modeEvidence(sid: string, token?: string, proof?: string): AdminModeEvidence {
  return {
    sid,
    tokenHash: createHash("sha256").update(`arcompt:admin-mode:v1\0${token ?? ""}`).digest("hex"),
    proofHash: createHash("sha256").update(`arcompt:mfa:proof:v1\0${proof ?? ""}`).digest("hex"),
  };
}
export async function resolveAdminMode(db: Sql, sub: string, e: AdminModeEvidence) {
  const [row] = await db`SELECT * FROM platform_mode_identity(${sub},${e.sid},${e.tokenHash},${e.proofHash})`;
  return row ? { userId: String(row.user_id), suspendedAt: null, locale: String(row.locale), expiresAt: new Date(row.expires_at).toISOString() } : null;
}
export async function modeCompanies(db: Sql, sub: string, e: AdminModeEvidence) {
  const rows = await db`SELECT * FROM platform_mode_companies(${sub},${e.sid},${e.tokenHash},${e.proofHash})`;
  return rows.map((r) => ({ companyId: String(r.company_id), companyName: String(r.company_name), organizationId: String(r.organization_id), organizationName: String(r.organization_name), countryCode: String(r.country_code) }));
}
export async function modeAccess(db: Sql, sub: string, e: AdminModeEvidence, company: string | null, method: string, path: string) {
  await db`SELECT platform_mode_record_access(${sub},${e.sid},${e.tokenHash},${e.proofHash},${company},${method},${path})`;
}
export function adminModeRoutes(db?: Sql) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!db) return c.json({ error: { code: "ADMIN_MODE_UNAVAILABLE", message: "Administration indisponible" } }, 503);
    if (!c.get("auth").mfaIdentity) return c.json({ error: { code: "UNAUTHORIZED", message: "Session Clerk requise" } }, 401);
    await next();
  });
  app.get("/status", async (c) => {
    const { sub, sid, email } = c.get("auth").mfaIdentity!;
    const [row] = await db!`SELECT platform_mode_eligible(${sub}) AS eligible, platform_mode_approved(${sub},${email}) AS approved`;
    const mode = await resolveAdminMode(db!, sub, modeEvidence(sid, c.req.header("x-arcompt-admin-mode"), c.req.header("x-arcompt-mfa")));
    return c.json({ eligible: row?.eligible === true || row?.approved === true, approvedPending: row?.approved === true, active: !!mode, expiresAt: mode?.expiresAt ?? null });
  });
  app.post("/activate", async (c) => {
    const { sub, sid, email } = c.get("auth").mfaIdentity!;
    const token = randomBytes(32).toString("base64url");
    const e = modeEvidence(sid, token, c.req.header("x-arcompt-mfa"));
    const [row] = await db!`SELECT platform_mode_activate_approved(${sub},${email},${sid},${e.proofHash},${e.tokenHash}) AS expires_at`;
    if (!row?.expires_at) return c.json({ error: { code: "MFA_REQUIRED", message: "Autorisation administrateur et vérification MFA récente requises" } }, 403);
    return c.json({ token, expiresAt: new Date(row.expires_at).toISOString() });
  });
  app.post("/deactivate", async (c) => {
    const { sub, sid } = c.get("auth").mfaIdentity!;
    const e = modeEvidence(sid, c.req.header("x-arcompt-admin-mode"));
    await db!`SELECT platform_mode_deactivate(${sub},${sid},${e.tokenHash})`;
    return c.json({ active: false });
  });
  return app;
}