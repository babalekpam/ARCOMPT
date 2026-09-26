import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_JOURNALS, Ledger, PostgresStore } from "@arcompt/ledger";
import { resolveChart, seedCompany, type Db } from "@arcompt/db";
import { createTestDatabase } from "../../../packages/db/src/testing.js";
import { createApp } from "./app.js";

const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken, createClerkClient: vi.fn() }));

const env = await createTestDatabase();
const run = env ? describe : describe.skip;
let db: Db;
let app: ReturnType<typeof createApp>;
const sub = "clerk_bootstrap_integration";
const email = "bootstrap.integration@example.test";
let activeSub = sub;
let activeEmail = email;

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  verifyToken.mockImplementation(async () => ({ sub: activeSub, sid: "sess_bootstrap", fva: [0, null] }));
  app = createApp({
    quiet: true,
    db: env.appDb,
    auth: {
      mode: "clerk",
      clerkSecretKey: "sk_test",
      authorizedParties: ["https://app.example"],
      clerkUserLookup: async () => ({ email: activeEmail, emailVerified: true, displayName: "Bootstrap Owner" }),
    },
    ledgerFor: (ctx) => new Ledger(new PostgresStore(env.appDb, { ...(ctx.userId ? { userId: ctx.userId } : {}), ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }), { baseCurrency: "XOF" }),
  });
});

afterAll(async () => { await env?.drop(); });

const headers = { authorization: "Bearer session", "content-type": "application/json" };
const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: "Integration Company",
  countryCode: "CI",
  packCode: "ci",
  fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
  ...over,
});

run("session bootstrap against PostgreSQL/RLS", () => {
  it("creates an owner, canonical national chart, periods, and replays safely", async () => {
    const first = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body() });
    expect(first.status).toBe(201);
    const { companyId } = await first.json() as { companyId: string };
    const again = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({ name: "Different" }) });
    expect(again.status).toBe(200);
    expect((await again.json() as { companyId: string }).companyId).toBe(companyId);
    const [owner] = await db`SELECT m.role FROM company_member m WHERE m.company_id = ${companyId}`;
    expect(owner?.role).toBe("OWNER");
    const [override] = await db`SELECT number, postable FROM account WHERE tenant_id = ${companyId} AND number = '4471'`;
    expect(override?.number).toBe("4471");
    const [parent] = await db`SELECT postable FROM account WHERE tenant_id = ${companyId} AND number = '447'`;
    expect(parent?.postable).toBe(false);
    const [fy] = await db`SELECT id FROM fiscal_year WHERE tenant_id = ${companyId} AND code = '2025'`;
    const [{ n }] = await db`SELECT count(*)::int AS n FROM period WHERE tenant_id = ${companyId} AND fiscal_year_id = ${fy!.id}` as unknown as [{ n: number }];
    expect(Number(n)).toBe(12);
    const [reference] = await db`SELECT
      (SELECT count(*)::int FROM account WHERE tenant_id = ${companyId}) AS accounts,
      (SELECT count(*)::int FROM journal WHERE tenant_id = ${companyId}) AS journals`;
    expect(Number(reference!.accounts)).toBeGreaterThanOrEqual(resolveChart().length);
    expect(Number(reference!.journals)).toBe(DEFAULT_JOURNALS.length);
    const [business] = await db`SELECT
      (SELECT count(*)::int FROM partner WHERE tenant_id = ${companyId}) AS partners,
      (SELECT count(*)::int FROM journal_entry WHERE tenant_id = ${companyId}) AS entries,
      (SELECT count(*)::int FROM journal_line WHERE tenant_id = ${companyId}) AS lines,
      (SELECT count(*)::int FROM account_balance WHERE tenant_id = ${companyId}) AS balances,
      (SELECT count(*)::int FROM document WHERE tenant_id = ${companyId}) AS documents,
      (SELECT count(*)::int FROM sales_document WHERE tenant_id = ${companyId}) AS sales,
      (SELECT count(*)::int FROM payment WHERE tenant_id = ${companyId}) AS payments`;
    expect(Object.values(business!).map(Number)).toEqual(Array(7).fill(0));
  });

  it("never assigns a demo tenant to a new identity or an existing non-member", async () => {
    activeSub = "clerk_no_membership";
    activeEmail = "no.membership@example.test";
    const unknown = await app.request("/v1/session/memberships", { headers: { authorization: "Bearer session" } });
    expect(unknown.status).toBe(200);
    expect((await unknown.json() as { companies: unknown[] }).companies).toEqual([]);
    const [org] = await db`INSERT INTO organization (name) VALUES ('No Membership Org') RETURNING id`;
    await db`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name)
      VALUES (${String(org!.id)}, ${activeSub}, ${activeEmail}, 'No Membership')`;
    const memberless = await app.request("/v1/session/memberships", { headers: { authorization: "Bearer session" } });
    expect(memberless.status).toBe(200);
    expect((await memberless.json() as { companies: unknown[] }).companies).toEqual([]);
    const rejected = await app.request("/v1/partners", { headers: { authorization: "Bearer session" } });
    expect(rejected.status).toBe(403);
    activeSub = sub;
    activeEmail = email;
  });

  it("shows only the signed-in owner's company/exercise reference, not the Clerk subject", async () => {
    const bootstrap = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body() });
    const { companyId } = await bootstrap.json() as { companyId: string };
    const requestReference = () => app.request("/v1/portal/org/members/self-reference", {
      headers: { authorization: "Bearer session", "x-tenant-id": companyId },
    });
    const before = await requestReference();
    expect(before.status).toBe(200);
    const original = (await before.json() as { reference: string }).reference;
    expect(original).toMatch(/^INTEGRATION-COMPANY-2025-\d{6,}$/);
    const year = new Date().getUTCFullYear();
    await db`INSERT INTO fiscal_year (tenant_id, code, start_date, end_date)
      VALUES (${companyId}, ${String(year)}, ${`${year}-01-01`}, ${`${year}-12-31`})`;
    const response = await requestReference();
    expect(response.status).toBe(200);
    const { reference } = await response.json() as { reference: string | null };
    expect(reference).toMatch(new RegExp(`^INTEGRATION-COMPANY-${year}-\\d{6,}$`));
    expect(reference?.split("-").at(-1)).toBe(original.split("-").at(-1));
    expect(reference).not.toContain(sub);
    const withoutCompany = await app.request("/v1/portal/org/members/self-reference", {
      headers: { authorization: "Bearer session" },
    });
    expect(withoutCompany.status).toBe(403);
  });

  it("rejects invalid dates and mismatched packs before any write", async () => {
    const badDate = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({
      name: "Bad Date", fiscalYear: { code: "2025", startDate: "2025-02-30", endDate: "2025-12-31" },
    }) });
    expect(badDate.status).toBe(422);
    const badPack = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({ name: "Bad Pack", countryCode: "SN", packCode: "ci" }) });
    expect(badPack.status).toBe(422);
    const [{ n }] = await db`SELECT count(*)::int AS n FROM organization WHERE name IN ('Bad Date', 'Bad Pack')` as unknown as [{ n: number }];
    expect(Number(n)).toBe(0);
  });

  it("rejects an email collision in another organization, including suspended users", async () => {
    const [org] = await db`INSERT INTO organization (name) VALUES ('Other collision organization') RETURNING id`;
    const otherSub = "clerk_collision_existing";
    const otherEmail = "collision.existing@example.test";
    await db`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name)
      VALUES (${String(org!.id)}, ${otherSub}, ${otherEmail}, 'Existing')`;
    activeSub = "clerk_collision_new";
    activeEmail = otherEmail;
    const memberships = await app.request("/v1/session/memberships", { headers: { authorization: "Bearer session" } });
    expect(memberships.status).toBe(200);
    expect((await memberships.json() as { canBootstrap: boolean }).canBootstrap).toBe(false);
    const rejected = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({ name: "Must Not Exist" }) });
    expect(rejected.status).toBe(409);
    const [{ n }] = await db`SELECT count(*)::int AS n FROM organization WHERE name = 'Must Not Exist'` as unknown as [{ n: number }];
    expect(Number(n)).toBe(0);

    await db`UPDATE app_user SET suspended_at = now() WHERE keycloak_sub = ${otherSub}`;
    activeSub = "clerk_collision_suspended";
    const suspended = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({ name: "Must Not Exist Suspended" }) });
    expect(suspended.status).toBe(409);
    const [{ n: n2 }] = await db`SELECT count(*)::int AS n FROM organization WHERE name = 'Must Not Exist Suspended'` as unknown as [{ n: number }];
    expect(Number(n2)).toBe(0);
  });

  it("does not resolve through temporary shadow tables under the app role", async () => {
    await env!.appDb.begin(async (tx) => {
      await tx`CREATE TEMP TABLE app_user (keycloak_sub text, email text, suspended_at timestamptz)`;
      const [row] = await tx`SELECT state FROM auth_bootstrap_lookup('shadow-sub', 'shadow@example.test')`;
      expect(row?.state).toBe("ELIGIBLE");
      await tx`DROP TABLE app_user`;
    });
  });

  it("rejects an existing Clerk subject without a replay record", async () => {
    const [org] = await db`INSERT INTO organization (name) VALUES ('Existing subject organization') RETURNING id`;
    activeSub = "clerk_existing_subject";
    activeEmail = "existing.subject@example.test";
    await db`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name)
      VALUES (${String(org!.id)}, ${activeSub}, ${activeEmail}, 'Existing subject')`;
    const existingCompany = await seedCompany(db, { organizationId: String(org!.id), name: "Existing Subject Company", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" } });
    const [existingUser] = await db`SELECT id FROM app_user WHERE keycloak_sub = ${activeSub}`;
    await db`INSERT INTO company_member (company_id, user_id, role) VALUES (${existingCompany.companyId}, ${String(existingUser!.id)}, 'OWNER')`;
    const rejected = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({ name: "Subject Must Not Exist" }) });
    expect([403, 409]).toContain(rejected.status);
    const [{ n }] = await db`SELECT count(*)::int AS n FROM organization WHERE name = 'Subject Must Not Exist'` as unknown as [{ n: number }];
    expect(Number(n)).toBe(0);
  });

  it("rolls back every provisioned row when the database seed fails", async () => {
    await db.unsafe(`CREATE OR REPLACE FUNCTION bootstrap_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional bootstrap seed failure'; END $$`);
    await db.unsafe(`CREATE TRIGGER bootstrap_test_failure_trigger AFTER INSERT ON fiscal_year FOR EACH ROW EXECUTE FUNCTION bootstrap_test_failure()`);
    activeSub = "clerk_seed_failure";
    activeEmail = "seed.failure@example.test";
    const failed = await app.request("/v1/session/bootstrap", { method: "POST", headers, body: body({ name: "Atomic Failure Company" }) });
    expect(failed.status).toBe(500);
    const [{ n }] = await db`SELECT count(*)::int AS n FROM organization WHERE name = 'Atomic Failure Company'` as unknown as [{ n: number }];
    expect(Number(n)).toBe(0);
    const [user] = await db`SELECT id FROM app_user WHERE keycloak_sub = ${activeSub}`;
    expect(user).toBeUndefined();
    const [company] = await db`SELECT id FROM company WHERE name = 'Atomic Failure Company'`;
    expect(company).toBeUndefined();
    await db.unsafe(`DROP TRIGGER bootstrap_test_failure_trigger ON fiscal_year`);
    await db.unsafe(`DROP FUNCTION bootstrap_test_failure()`);
  });
});