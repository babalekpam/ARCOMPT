import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDatabase } from "@arcompt/db/testing";
import { authMiddleware, type AuthContext } from "./auth.js";
import { decryptMfa, mfaRoutes, mfaStatus, totp } from "./mfa.js";
import { assertProductionDatabaseSecurity } from "./database-readiness.js";

const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken, createClerkClient: vi.fn() }));
const env = await createTestDatabase();
const run = env ? describe : describe.skip;
let sub = "pre_onboarding", sid = "session_a", emailVerified = true;
const app = new Hono<{ Variables: { auth: AuthContext } }>();
const identity = vi.fn(async () => null);
beforeAll(() => {
  vi.stubEnv("PAYROLL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  verifyToken.mockImplementation(async () => ({ sub, sid, fva: [0, null] }));
  app.use("*", authMiddleware({
    mode: "clerk", clerkSecretKey: "test", authorizedParties: ["https://app.example"],
    resolveIdentity: identity,
    clerkUserLookup: async () => ({ email: `${sub}@example.test`, emailVerified }),
    resolveAppMfa: (subject, session, proof) => mfaStatus(env!.appDb, subject, session, proof),
    resolvePlatformAdmin: async () => ({ userId: "00000000-0000-4000-8000-000000000001", suspendedAt: null, locale: null }),
    recordPlatformAccess: async () => {},
  }));
  app.route("/v1/security/mfa", mfaRoutes(env?.appDb));
  app.get("/v1/platform/me", (c) => c.json({ admin: c.get("auth").platformAdmin }));
});
afterAll(async () => { vi.unstubAllEnvs(); await env?.drop(); });
const req = (action: string, code?: string, proof?: string) => app.request(`/v1/security/mfa/${action}`, {
  method: action === "status" ? "GET" : "POST",
  headers: { authorization: "Bearer session", "content-type": "application/json", ...(proof ? { "x-arcompt-mfa": proof } : {}) },
  ...(code !== undefined ? { body: JSON.stringify({ code }) } : {}),
});
async function codeFor(subject: string, offset = 0) {
  const [row] = await env!.db`SELECT secret_cipher FROM app_mfa_factor WHERE clerk_sub = ${subject}`;
  return totp(decryptMfa(row!.secret_cipher, subject), Math.floor(Date.now() / 30000) + offset);
}
run("app MFA on restricted PostgreSQL", () => {
  it("has complete readiness, forced RLS and no direct factor/proof privileges", async () => {
    await assertProductionDatabaseSecurity(env!.appDb);
    for (const table of ["app_mfa_factor", "app_mfa_proof"]) {
      await expect(env!.appDb.unsafe(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      const [row] = await env!.db`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ${table}`;
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });
  it("enrolls before app_user without resolving tenant/admin identity; does not enable before confirmation", async () => {
    expect(await (await req("status")).json()).toEqual({ enabled: false, verified: false });
    const response = await req("enroll");
    expect(response.status).toBe(200);
    const enrollment = await response.json() as { secret: string; otpauthUri: string };
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrollment.otpauthUri).toContain("otpauth://totp/ARCOMPT");
    expect(identity).not.toHaveBeenCalled();
    expect(await (await req("status")).json()).toEqual({ enabled: false, verified: false });
    expect((await req("confirm", "invalid")).status).toBe(400);
  });
  it("confirms once, binds proof to sub+sid and gates administrators on proof rather than enrollment", async () => {
    const code = await codeFor(sub);
    const confirmed = await req("confirm", code);
    expect(confirmed.status).toBe(200);
    const result = await confirmed.json() as { proof: string; recoveryCodes: string[] };
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const status = await (await req("status", undefined, result.proof)).json();
    expect(status).toMatchObject({ enabled: true, verified: true });
    expect(status).not.toHaveProperty("proof");
    const platform = (proof?: string) => app.request("/v1/platform/me", { headers: { authorization: "Bearer session", ...(proof ? { "x-arcompt-mfa": proof } : {}) } });
    expect((await platform()).status).toBe(403);
    expect((await platform("true")).status).toBe(403);
    expect((await platform(result.proof)).status).toBe(200);
    expect((await req("verify", code)).status).toBe(400);
    expect((await req("enroll")).status).toBe(400);
    sid = "other_session";
    expect((await platform(result.proof)).status).toBe(403);
    expect((await mfaStatus(env!.appDb, "other_user", "session_a", result.proof)).verified).toBe(false);
    sid = "session_a";
    await env!.db`UPDATE app_mfa_proof SET expires_at = now() - interval '1 second'`;
    expect((await platform(result.proof)).status).toBe(403);
    // Concurrent use of the same recovery code succeeds exactly once.
    const attempts = await Promise.all([req("verify", result.recoveryCodes[0]), req("verify", result.recoveryCodes[0])]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await req("recovery-codes", result.recoveryCodes[1])).status).toBe(400);
  });
  it("requires fresh TOTP for regeneration and invalidates old recovery codes", async () => {
    sub = "regeneration";
    await req("enroll");
    const first = await (await req("confirm", await codeFor(sub, -1))).json() as { recoveryCodes: string[] };
    const next = await req("recovery-codes", await codeFor(sub));
    expect(next.status).toBe(200);
    expect((await next.json() as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
    expect((await req("verify", first.recoveryCodes[0])).status).toBe(400);
    expect((await req("recovery-codes", await codeFor(sub))).status).toBe(400);
  });
  it("enforces voluntary enrollment for ordinary non-MFA tenants and new sessions, but exempts only ceremony", async () => {
    sub = "ordinary_opt_in";
    sid = "ordinary_first";
    const tenant = "11111111-1111-4111-8111-111111111111";
    const ordinary = new Hono();
    const resolveIdentity = vi.fn(async () => ({
      userId: "22222222-2222-4222-8222-222222222222",
      organizationId: "33333333-3333-4333-8333-333333333333",
      suspendedAt: null, locale: null, mfaRequired: false,
      memberships: [{ companyId: tenant, role: "OWNER" as const }],
    }));
    ordinary.use("*", authMiddleware({
      mode: "clerk", clerkSecretKey: "test", authorizedParties: ["https://app.example"],
      resolveIdentity,
      clerkUserLookup: async () => ({ email: `${sub}@example.test`, emailVerified: true }),
      resolveAppMfa: (subject, session, proof) => mfaStatus(env!.appDb, subject, session, proof),
    }));
    ordinary.get("/v1/ordinary", (c) => c.json({ ok: true }));
    ordinary.get("/v1/session/memberships", (c) => c.json({ ok: true }));
    ordinary.post("/v1/session/bootstrap", (c) => c.json({ ok: true }));
    ordinary.post("/v1/portal/org/invitations/accept", (c) => c.json({ ok: true }));
    ordinary.route("/v1/security/mfa", mfaRoutes(env!.appDb));
    const request = (path = "/v1/ordinary", proof?: string) => ordinary.request(path, {
      method: path.endsWith("bootstrap") || path.endsWith("accept") ? "POST" : "GET",
      headers: { authorization: "Bearer session", "x-tenant-id": tenant, ...(proof ? { "x-arcompt-mfa": proof } : {}) },
    });
    expect((await request()).status).toBe(200); // Unenrolled users remain unaffected.
    await req("enroll");
    expect((await request()).status).toBe(200); // Pending is not confirmed.
    const confirmed = await (await req("confirm", await codeFor(sub))).json() as { proof: string; recoveryCodes: string[] };
    expect((await request(undefined, confirmed.proof)).status).toBe(200);
    resolveIdentity.mockClear();
    sid = "ordinary_new_session";
    for (const path of ["/v1/ordinary", "/v1/session/memberships", "/v1/session/bootstrap", "/v1/portal/org/invitations/accept"]) {
      const response = await request(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "MFA_REQUIRED" } });
    }
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect((await request(undefined, confirmed.proof)).status).toBe(403);
    const status = await request("/v1/security/mfa/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ enabled: true, verified: false });
    const verified = await ordinary.request("/v1/security/mfa/verify", {
      method: "POST", headers: { authorization: "Bearer session", "content-type": "application/json" },
      body: JSON.stringify({ code: confirmed.recoveryCodes[0] }),
    });
    expect(verified.status).toBe(200);
    const { proof } = await verified.json() as { proof: string };
    expect((await request(undefined, proof)).status).toBe(200);
    expect((await request("/v1/session/memberships", proof)).status).toBe(200);
    verifyToken.mockResolvedValueOnce({ sub, sid, fva: [0, 0] });
    expect((await request()).status).toBe(200); // Existing IdP MFA remains sufficient.
  });
  it("rejects expired pending enrollment and persists throttling across API instances and concurrent calls", async () => {
    sub = "expired";
    await req("enroll");
    await env!.db`UPDATE app_mfa_factor SET pending_until = now() - interval '1 second' WHERE clerk_sub = ${sub}`;
    expect((await req("confirm", await codeFor(sub))).status).toBe(400);
    sub = "limited";
    const attempts = await Promise.all(Array.from({ length: 15 }, () => req("verify", "bad")));
    expect(attempts.filter((r) => r.status === 400)).toHaveLength(10);
    expect(attempts.filter((r) => r.status === 429)).toHaveLength(5);
    const [persisted] = await env!.appDb`SELECT app_mfa_attempt(${sub}) AS allowed`;
    expect(persisted?.allowed).toBe(false);
    await env!.db`UPDATE app_mfa_factor SET attempt_start = now() - interval '16 minutes' WHERE clerk_sub = ${sub}`;
    expect((await req("enroll")).status).toBe(200);
  });
  it("requires verified primary email, session claims and Clerk mode", async () => {
    emailVerified = false;
    expect((await req("status")).status).toBe(403);
    emailVerified = true;
    verifyToken.mockResolvedValueOnce({ sub, fva: [0, 0] });
    expect((await req("status")).status).toBe(401);
    const dev = new Hono();
    dev.use("*", authMiddleware({ mode: "dev" }));
    dev.route("/v1/security/mfa", mfaRoutes(env!.appDb));
    expect((await dev.request("/v1/security/mfa/status", { headers: { "x-user-id": "fake", "x-tenant-id": "fake" } })).status).toBe(401);
  });
});