import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDatabase } from "@arcompt/db/testing";
import { authMiddleware, type AuthContext } from "./auth.js";
import { adminModeRoutes, modeEvidence, resolveAdminMode, modeCompanies, modeAccess } from "./admin-mode.js";
import { mfaStatus } from "./mfa.js";
import { resolveIdentity, resolvePlatformAdmin } from "./identity.js";
const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken, createClerkClient: vi.fn() }));
const env = await createTestDatabase();
const run = env ? describe : describe.skip;
let sid = "session", sub = "customer_admin", token = "", customerId = "", principalId = "", ownCompany = "", otherCompany = "";
const proof = "a".repeat(43);
const app = new Hono<{ Variables: { auth: AuthContext } }>();
beforeAll(async () => {
  if (!env) return;
  const [customerOrg] = await env.db`INSERT INTO organization(name) VALUES('Customer') RETURNING id`;
  const [otherOrg] = await env.db`INSERT INTO organization(name) VALUES('Other') RETURNING id`;
  const [internal] = await env.db`INSERT INTO organization(name) VALUES('__ARCOMPT_PLATFORM_INTERNAL__') RETURNING id`;
  await env.db`INSERT INTO platform_admin_reserved_org(organization_id) VALUES(${internal!.id})`;
  const [customer] = await env.db`INSERT INTO app_user(organization_id,keycloak_sub,email,display_name)
    VALUES(${customerOrg!.id},${sub},'dual@example.test','Customer') RETURNING id`;
  customerId = customer!.id;
  const [principal] = await env.db`INSERT INTO app_user(organization_id,email,display_name)
    VALUES(${internal!.id},'dual@example.test','Admin') RETURNING id`;
  principalId = principal!.id;
  await env.db`INSERT INTO platform_admin(user_id) VALUES(${principalId})`;
  await env.db`INSERT INTO platform_admin_binding VALUES(${sub},${principalId})`;
  for (const [org, name] of [[customerOrg!.id, "Own"], [otherOrg!.id, "Other"]]) {
    const [company] = await env.db`INSERT INTO company(organization_id,name,country_code,currency,pack_version)
      VALUES(${org},${name},'TG','XOF','1.0.0') RETURNING id`;
    if (name === "Own") ownCompany = company!.id; else otherCompany = company!.id;
  }
  await env.db`INSERT INTO company_member(company_id,user_id,role) VALUES(${ownCompany},${customerId},'ACCOUNTANT')`;
  await env.db`INSERT INTO app_mfa_factor(clerk_sub,enabled_at) VALUES(${sub},now())`;
  const evidence = modeEvidence(sid, "", proof);
  await env.db`INSERT INTO app_mfa_proof VALUES(${evidence.proofHash},${sub},${sid},now()+interval '15 minutes')`;
  verifyToken.mockImplementation(async () => ({ sub, sid, fva: [0, null] }));
  app.use("*", authMiddleware({
    mode: "clerk", clerkSecretKey: "test", authorizedParties: ["https://app.example"],
    clerkUserLookup: async () => ({ email: "dual@example.test", emailVerified: true }),
    resolveIdentity: (s, hints) => resolveIdentity(env.appDb, s, hints),
    resolveAppMfa: (s, session, p) => mfaStatus(env.appDb, s, session, p),
    resolvePlatformAdmin: (s) => resolvePlatformAdmin(env.appDb, s),
    resolveAdminMode: (s, e) => resolveAdminMode(env.appDb, s, e),
    resolvePlatformCompany: async (s, c, e) => e ? (await modeCompanies(env.appDb, s, e)).find((x) => x.companyId === c) ?? null : null,
    recordPlatformAccess: async (s, c, m, p, e) => { if (!e) throw new Error("No mode"); await modeAccess(env.appDb, s, e, c, m, p); },
  }));
  app.route("/v1/security/admin-mode", adminModeRoutes(env.appDb));
  app.get("/v1/test", (c) => { const a = c.get("auth"); return c.json({ userId: a.userId, admin: !!a.platformAdmin, roles: a.roles }); });
  app.get("/v1/platform/me", (c) => c.get("auth").platformAdmin ? c.json({ admin: true }) : c.json({},403));
});
afterAll(async () => { await env?.drop(); });
function request(path: string, mode?: string, tenant?: string, mfa = proof, expected = false) {
  return app.request(path, {
    method: /activate$/.test(path) ? "POST" : "GET",
    headers: { authorization: "Bearer session", "x-arcompt-mfa": mfa, ...(mode ? { "x-arcompt-admin-mode": mode } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}), ...(expected ? { "x-arcompt-admin-mode-expected": "1" } : {}) },
  });
}
run("explicit dual-identity administrator mode", () => {
  it("forces RLS and denies direct runtime table access", async () => {
    for (const table of ["platform_admin_binding", "platform_admin_mode"]) {
      await expect(env!.appDb.unsafe(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      const [row] = await env!.db`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=${table}`;
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
    expect(await resolvePlatformAdmin(env!.appDb, sub)).toBeNull();
  });
  it("defaults to customer identity with its own memberships, never platform privilege", async () => {
    const r = await request("/v1/test", undefined, ownCompany);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ userId: customerId, admin: false, roles: ["ACCOUNTANT"] });
    expect((await request("/v1/test", undefined, otherCompany)).status).toBe(403);
    expect((await request("/v1/platform/me")).status).toBe(403);
    expect(await (await request("/v1/security/admin-mode/status")).json()).toMatchObject({ eligible: true, active: false });
  });
  it("requires fresh session-bound MFA and explicit activation", async () => {
    expect((await request("/v1/security/admin-mode/activate", undefined, undefined, "forged")).status).toBe(403);
    const r = await request("/v1/security/admin-mode/activate");
    expect(r.status).toBe(200);
    token = (await r.json() as {token: string}).token;
    const evidence = modeEvidence(sid, token, proof);
    const [stored] = await env!.db`SELECT token_hash,expires_at FROM platform_admin_mode`;
    expect(stored!.token_hash).toBe(evidence.tokenHash);
    expect(stored!.token_hash).not.toBe(token);
    expect((await request("/v1/test", "arbitrary-header", otherCompany)).status).toBe(403);
    const result = await request("/v1/test", token, otherCompany);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ userId: principalId, admin: true, roles: ["OWNER"] });
    expect((await request("/v1/platform/me", token)).status).toBe(200);
    sid = "different_session";
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    sid = "session";
    sub = "other_subject";
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    sub = "customer_admin";
  });
  it("deactivates and audits transitions without changing customer data", async () => {
    expect((await request("/v1/security/admin-mode/deactivate", token)).status).toBe(200);
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    expect((await request("/v1/test", undefined, ownCompany)).status).toBe(200);
    const audits = await env!.db`SELECT reason FROM platform_admin_audit WHERE reason IS NOT NULL ORDER BY id`;
    expect(audits.map((a) => a.reason)).toEqual(["ADMIN_MODE_ACTIVATE", "ADMIN_MODE_DEACTIVATE"]);
    const [customer] = await env!.db`SELECT keycloak_sub FROM app_user WHERE id=${customerId}`;
    expect(customer!.keycloak_sub).toBe(sub);
    expect(await env!.db`SELECT * FROM company_member WHERE user_id=${customerId}`).toHaveLength(1);
  });
  it("retains a deny-only tombstone after browser token expiry, even for a customer-owned tenant", async () => {
    const expiredCookie = await request("/v1/test", undefined, ownCompany, proof, true);
    expect(expiredCookie.status).toBe(403);
    expect(await expiredCookie.json()).toMatchObject({ error: { code: "ADMIN_MODE_EXPIRED" } });
    sid = "new_session";
    expect((await request("/v1/test", undefined, ownCompany, proof, true)).status).toBe(403);
    sub = "new_login";
    expect((await request("/v1/test", undefined, ownCompany, proof, true)).status).toBe(403);
    // Status and explicit exit remain available despite stale mode/MFA evidence.
    expect((await request("/v1/security/admin-mode/deactivate", undefined, undefined, "", true)).status).toBe(200);
    sid = "session"; sub = "customer_admin";
    expect((await request("/v1/test", undefined, ownCompany)).status).toBe(200);
  });
  it("fails closed on revocation, expiry, suspension and removed MFA", async () => {
    token = (await (await request("/v1/security/admin-mode/activate")).json() as {token: string}).token;
    await env!.db`UPDATE app_user SET suspended_at=now() WHERE id=${customerId}`;
    expect((await request("/v1/test", undefined, ownCompany)).status).toBe(403);
    expect((await request("/v1/test", token, otherCompany)).status).toBe(200);
    await env!.db`UPDATE app_user SET suspended_at=NULL WHERE id=${customerId}`;
    await env!.db`UPDATE platform_admin SET active=false WHERE user_id=${principalId}`;
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    expect((await request("/v1/security/admin-mode/activate")).status).toBe(403);
    await env!.db`UPDATE platform_admin SET active=true WHERE user_id=${principalId}`;
    await env!.db`UPDATE app_user SET suspended_at=now() WHERE id=${principalId}`;
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    await env!.db`UPDATE app_user SET suspended_at=NULL WHERE id=${principalId}`;
    await env!.db`UPDATE platform_admin_mode SET expires_at=now()-interval '1 second'`;
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    token = (await (await request("/v1/security/admin-mode/activate")).json() as {token: string}).token;
    await env!.db`DELETE FROM app_mfa_proof WHERE clerk_sub=${sub}`;
    expect((await request("/v1/test", token, otherCompany)).status).toBe(403);
    expect(await env!.db`SELECT * FROM platform_admin_mode`).toHaveLength(0);
  });
  it("email linking cannot take over an unbound platform principal", async () => {
    await env!.db`UPDATE app_user SET email='customer-renamed@example.test' WHERE id=${customerId}`;
    const [row] = await env!.appDb`SELECT auth_link_subject('attacker','dual@example.test') AS id`;
    expect(row!.id).toBeNull();
    const [internal] = await env!.db`SELECT keycloak_sub FROM app_user WHERE id=${principalId}`;
    expect(internal!.keycloak_sub).toBeNull();
  });
});