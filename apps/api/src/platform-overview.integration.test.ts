import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestDatabase } from "@arcompt/db/testing";
import { platformRoutes } from "./routes/platform.js";
import { modeEvidence } from "./admin-mode.js";

const env = await createTestDatabase();
const suite = env ? describe : describe.skip;
const evidence = modeEvidence("sid", "token", "proof");
beforeAll(async () => {
  if (!env) return;
  await env.db.unsafe(`INSERT INTO organization(id,name) VALUES
    ('11111111-1111-4111-8111-111111111111','Tenant'),
    ('22222222-2222-4222-8222-222222222222','Empty tenant'),
    ('33333333-3333-4333-8333-333333333333','Internal');
    INSERT INTO platform_admin_reserved_org(organization_id) VALUES('33333333-3333-4333-8333-333333333333');
    INSERT INTO app_user(id,organization_id,email,display_name,keycloak_sub) VALUES
    ('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','admin@example.test','Admin',NULL),
    ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','user@example.test','Customer','subject');
    INSERT INTO platform_admin(user_id) VALUES('44444444-4444-4444-8444-444444444444');
    INSERT INTO platform_admin_binding VALUES('subject','44444444-4444-4444-8444-444444444444');
    INSERT INTO company(organization_id,name,country_code,currency,pack_version)
    VALUES('11111111-1111-4111-8111-111111111111','Company','TG','XOF','1.0.0');
    INSERT INTO app_mfa_factor(clerk_sub,enabled_at) VALUES('subject',now());`);
  await env.db`INSERT INTO app_mfa_proof VALUES(${evidence.proofHash},'subject','sid',now()+interval '15 minutes')`;
  await env.appDb`SELECT platform_mode_activate('subject','sid',${evidence.proofHash},${evidence.tokenHash})`;
});
afterAll(async () => { await env?.drop(); });
suite("platform overview real data and access", () => {
  it("includes empty tenants, counts customer users once, excludes internal principal and audits", async () => {
    const [row] = await env!.appDb`SELECT platform_overview('subject','sid',${evidence.tokenHash},${evidence.proofHash}) AS data`;
    expect(row!.data.totals).toEqual({ organizations: 2, companies: 1, users: 1, activeUsers: 1, suspendedUsers: 0 });
    expect(row!.data.organizations.find((o: {name:string}) => o.name === "Empty tenant").companies).toEqual([]);
    const [audit] = await env!.db`SELECT count(*)::int AS n FROM platform_admin_audit WHERE path='/platform/overview'`;
    expect(audit!.n).toBeGreaterThan(0);
  });
  it("rejects forged/expired mode and ordinary subject legacy fallback", async () => {
    for (const [sub,sid,token,proof] of [["subject","wrong",evidence.tokenHash,evidence.proofHash],["other","sid",evidence.tokenHash,evidence.proofHash],["subject",null,null,null]] as const) {
      await expect(env!.appDb`SELECT platform_overview(${sub},${sid},${token},${proof})`).rejects.toMatchObject({code:"42501"});
    }
    await env!.db`UPDATE platform_admin_mode SET expires_at=now()-interval '1 second'`;
    await expect(env!.appDb`SELECT platform_overview('subject','sid',${evidence.tokenHash},${evidence.proofHash})`).rejects.toMatchObject({code:"42501"});
  });
});
describe("overview HTTP guard", () => {
  it("refuses an ordinary account without invoking discovery", async () => {
    const app = new Hono();
    app.use("*", async (c,next) => { c.set("auth",{userId:"customer",tenantId:"tenant",roles:["OWNER"]}); await next(); });
    app.route("/platform",platformRoutes(undefined,async () => { throw Error("must not be called"); }));
    expect((await app.request("/platform/overview")).status).toBe(403);
  });
});
