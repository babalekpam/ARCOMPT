import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createTestDatabase } from "@arcompt/db/testing";
import { adminModeRoutes, modeEvidence } from "./admin-mode.js";
import { authMiddleware } from "./auth.js";
const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken, createClerkClient: vi.fn() }));
const env = await createTestDatabase();
const run = env ? describe : describe.skip;
const sub = "approved_customer", email = "approved@example.test", sid = "approved_session";
const e = modeEvidence(sid, "mode", "proof");
let customer: string;
let verifiedEmail = email;
const app = new Hono();
beforeAll(async () => {
  if (!env) return;
  const [org] = await env.db`INSERT INTO organization(name) VALUES('Customer') RETURNING id`;
  const [user] = await env.db`INSERT INTO app_user(organization_id,keycloak_sub,email,display_name)
    VALUES(${org!.id},${sub},${email},'Customer') RETURNING id`;
  customer = user!.id;
  for (const name of ["First", "Second"]) {
    const [company] = await env.db`INSERT INTO company(organization_id,name,country_code,currency,pack_version)
      VALUES(${org!.id},${name},'TG','XOF','1.0.0') RETURNING id`;
    await env.db`INSERT INTO company_member(company_id,user_id,role) VALUES(${company!.id},${customer},'ACCOUNTANT')`;
  }
  await env.db`INSERT INTO app_mfa_factor(clerk_sub,enabled_at) VALUES(${sub},now())`;
  await env.db`INSERT INTO app_mfa_proof VALUES(${e.proofHash},${sub},${sid},now()+interval '15 minutes')`;
  verifyToken.mockResolvedValue({ sub, sid });
  app.use("*", authMiddleware({ mode: "clerk", clerkSecretKey: "test", authorizedParties: ["https://example.test"],
    resolveIdentity: async () => null, clerkUserLookup: async () => ({ email: verifiedEmail, emailVerified: true }) }));
  app.route("/security/admin-mode", adminModeRoutes(env.appDb));
});
afterAll(async () => { await env?.drop(); });
async function activate(s = sub, mail = email, session = sid, proof = e.proofHash, hash = e.tokenHash) {
  const [row] = await env!.appDb`SELECT platform_mode_activate_approved(${s},${mail},${session},${proof},${hash}) AS until`;
  return row!.until;
}
run("privileged preapproval", () => {
  it("cannot self-approve and requires approval before granting", async () => {
    expect(await activate()).toBeNull();
    for (const sql of ["SELECT * FROM platform_admin_preapproval",
      "INSERT INTO platform_admin_preapproval(clerk_sub) VALUES('attacker')",
      "UPDATE platform_admin_preapproval SET expires_at=now()+interval '1 year'"]) {
      await expect(env!.appDb.unsafe(sql)).rejects.toThrow(/permission denied/);
    }
    const [table] = await env!.db`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='platform_admin_preapproval'`;
    expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    await env!.db`INSERT INTO platform_admin_preapproval(clerk_sub,expected_email,expires_at,operator_label,reason)
      VALUES(${sub},${email},now()+interval '1 day','Approved operator','Approved reason')`;
  });
  it("status is read-only; wrong identity/session/proof and malformed mode never grant", async () => {
    for (const args of [[sub,"wrong@example.test",sid,e.proofHash], ["wrong",email,sid,e.proofHash],
      [sub,email,"wrong",e.proofHash], [sub,email,sid,"0".repeat(64)]]) {
      expect(await activate(...args as [string,string,string,string])).toBeNull();
    }
    expect(await activate(sub,email,sid,e.proofHash,"invalid")).toBeNull();
    const [status] = await env!.appDb`SELECT platform_mode_approved(${sub},${email}) AS approved`;
    expect(status!.approved).toBe(true);
    expect(await env!.db`SELECT * FROM platform_admin_binding`).toHaveLength(0);
    const headers = { authorization: "Bearer verified" };
    verifiedEmail = "wrong@example.test";
    expect(await (await app.request("/security/admin-mode/status", { headers })).json()).toMatchObject({ eligible: false, approvedPending: false });
    // Request bodies cannot replace the verified profile or supply approval.
    expect((await app.request("/security/admin-mode/activate", { method: "POST",
      headers: { ...headers, "x-arcompt-mfa": "proof", "content-type": "application/json" },
      body: JSON.stringify({ email, sub, approved: true }) })).status).toBe(403);
    verifiedEmail = email;
    expect(await (await app.request("/security/admin-mode/status", { headers })).json()).toMatchObject({ eligible: true, approvedPending: true, active: false });
    expect(await env!.db`SELECT * FROM platform_admin_binding`).toHaveLength(0);
  });
  it("rejects expired/revoked approvals, suspended customer and disabled MFA", async () => {
    await env!.db`UPDATE platform_admin_preapproval SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day'`;
    expect(await activate()).toBeNull();
    await env!.db`UPDATE platform_admin_preapproval SET expires_at=now()+interval '1 day',revoked_at=now()`;
    expect(await activate()).toBeNull();
    await env!.db`UPDATE platform_admin_preapproval SET revoked_at=NULL`;
    await env!.db`UPDATE app_user SET suspended_at=now() WHERE id=${customer}`;
    expect(await activate()).toBeNull();
    await env!.db`UPDATE app_user SET suspended_at=NULL WHERE id=${customer}`;
    await env!.db`UPDATE app_mfa_factor SET enabled_at=NULL WHERE clerk_sub=${sub}`;
    expect(await activate()).toBeNull();
    await env!.db`UPDATE app_mfa_factor SET enabled_at=now() WHERE clerk_sub=${sub}`;
  });
  it("atomically grants, audits and activates while preserving multiple memberships; returns and cannot revive revoked grant", async () => {
    expect(await activate()).not.toBeNull();
    const [binding] = await env!.db`SELECT user_id FROM platform_admin_binding WHERE clerk_sub=${sub}`;
    expect(binding!.user_id).not.toBe(customer);
    const [audit] = await env!.db`SELECT operator_label,reason,clerk_sid FROM platform_admin_audit WHERE event='GRANT'`;
    expect(audit).toMatchObject({ operator_label: "Approved operator", reason: "Approved reason", clerk_sid: sid });
    expect(await env!.appDb`SELECT * FROM platform_mode_identity(${sub},${sid},${e.tokenHash},${e.proofHash})`).toHaveLength(1);
    await env!.appDb`SELECT platform_mode_deactivate(${sub},${sid},${e.tokenHash})`;
    expect(await env!.db`SELECT * FROM platform_admin_mode`).toHaveLength(0);
    expect(await env!.db`SELECT * FROM company_member WHERE user_id=${customer}`).toHaveLength(2);
    const [user] = await env!.db`SELECT keycloak_sub FROM app_user WHERE id=${customer}`;
    expect(user!.keycloak_sub).toBe(sub);
    expect(await activate()).not.toBeNull(); // Existing grant, not another grant.
    expect(await env!.db`SELECT * FROM platform_admin_audit WHERE event='GRANT'`).toHaveLength(1);
    await env!.db`UPDATE platform_admin SET active=false WHERE user_id=${binding!.user_id}`;
    expect(await env!.db`SELECT * FROM platform_admin_mode`).toHaveLength(0);
    expect(await activate()).toBeNull();
    const [approval] = await env!.db`SELECT consumed_at,revoked_at FROM platform_admin_preapproval`;
    expect(approval!.consumed_at).not.toBeNull();
    expect(approval!.revoked_at).not.toBeNull();
  });
});