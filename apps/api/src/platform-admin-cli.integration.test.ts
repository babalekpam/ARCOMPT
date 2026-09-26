import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "@arcompt/db/testing";
import { clerkVerify, main } from "../../../scripts/platform-admin.mjs";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;
const originalArgv = process.argv;
let subject = "cli_mfa_test";
let idpMfa = false;
let email = "cli@example.test";
let verified = true;
beforeEach(() => {
  if (!env) return;
  vi.stubEnv("DATABASE_URL", env.url);
  vi.stubEnv("CLERK_SECRET_KEY", "test-only");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: subject, primary_email_address_id: "primary", two_factor_enabled: idpMfa,
    email_addresses: [{ id: "primary", email_address: email, verification: { status: verified ? "verified" : "unverified" } }],
  }), { status: 200 })));
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await env?.drop(); });
function args(action = "grant", apply = false) {
  process.argv = ["node", "/test/platform-admin.mts", "--action", action, "--sub", subject,
    "--email", email, "--reason", "isolated integration test", "--operator", "test",
    ...(apply ? ["--apply", "--confirm-db", new URL(env!.url).pathname.slice(1)] : [])];
}
run("platform admin CLI with app-owned MFA (disposable database only)", () => {
  it("checks exact subject, primary email and verified address independently of IdP MFA", async () => {
    expect(await clerkVerify(subject, email)).toBe(false);
    await expect(clerkVerify("different", email)).rejects.toThrow(/correspondent/);
    await expect(clerkVerify(subject, "different@example.test")).rejects.toThrow(/correspondent/);
    verified = false;
    await expect(clerkVerify(subject, email)).rejects.toThrow(/correspondent/);
    verified = true;
  });
  it("rejects absent/pending MFA, previews without grants, and only applies explicitly with an immutable audit", async () => {
    args();
    await expect(main()).rejects.toThrow(/MFA obligatoire/);
    await env!.db`INSERT INTO app_mfa_factor(clerk_sub, secret_cipher, pending_until)
      VALUES (${subject}, 'encrypted-test-fixture', now() + interval '10 minutes')`;
    await expect(main()).rejects.toThrow(/MFA obligatoire/);
    await env!.db`UPDATE app_mfa_factor SET enabled_at = now(), pending_until = NULL WHERE clerk_sub = ${subject}`;
    await main();
    expect(await env!.db`SELECT * FROM platform_admin`).toHaveLength(0);
    args("grant", true);
    await main();
    expect(await env!.db`SELECT * FROM platform_admin WHERE active`).toHaveLength(1);
    expect(await env!.db`SELECT event, reason FROM platform_admin_audit`).toEqual([{ event: "GRANT", reason: "isolated integration test" }]);
    args("revoke", true);
    await main();
    expect(await env!.db`SELECT * FROM platform_admin WHERE active`).toHaveLength(0);
    expect(await env!.db`SELECT event FROM platform_admin_audit ORDER BY id`).toEqual([{ event: "GRANT" }, { event: "REVOKE" }]);
    const [factor] = await env!.db`SELECT enabled_at FROM app_mfa_factor WHERE clerk_sub = ${subject}`;
    expect(factor?.enabled_at).toBeTruthy();
  });
  it("rejects tenant-linked users even with IdP MFA and refuses restricted runtime roles", async () => {
    subject = "tenant_linked";
    email = "tenant@example.test";
    idpMfa = true;
    const [org] = await env!.db`INSERT INTO organization(name) VALUES('Tenant test') RETURNING id`;
    await env!.db`INSERT INTO app_user(organization_id, keycloak_sub, email, display_name)
      VALUES(${org!.id}, ${subject}, ${email}, 'Test')`;
    args("grant", true);
    await expect(main()).rejects.toThrow(/tenant/);
    const restricted = new URL(env!.url);
    restricted.username = "arcompt_app_login"; restricted.password = "arcompt_app";
    vi.stubEnv("DATABASE_URL", restricted.toString());
    await expect(main()).rejects.toThrow(/privilégié/);
  });
});