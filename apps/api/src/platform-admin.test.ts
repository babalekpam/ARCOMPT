import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({ verifyToken, createClerkClient: vi.fn() }));

import { authMiddleware } from "./auth.js";
import { platformRoutes } from "./routes/platform.js";
import type { Identity } from "./identity.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const FORGED = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const ADMIN_USER = "44444444-4444-4444-8444-444444444444";

const ordinaryIdentity: Identity = {
  userId: "55555555-5555-4555-8555-555555555555",
  organizationId: ORG,
  suspendedAt: null,
  mfaRequired: false,
  locale: null,
  memberships: [{ companyId: COMPANY, role: "ACCOUNTANT" }],
};

type Options = {
  admin?: { suspendedAt?: Date | null } | null;
  company?: { companyId: string; organizationId: string } | null;
  companies?: Array<{ companyId: string; companyName: string; organizationId: string; organizationName: string; countryCode: string }>;
  audit?: () => Promise<void>;
  identity?: Identity | null;
  mode?: "clerk" | "dev" | "oidc";
};

function app(options: Options = {}) {
  const resolvePlatformAdmin = vi.fn(async () => options.admin === undefined ? { userId: ADMIN_USER, suspendedAt: null, locale: "fr" } : options.admin === null ? null : { userId: ADMIN_USER, suspendedAt: options.admin.suspendedAt ?? null, locale: "fr" });
  const resolvePlatformCompany = vi.fn(async () => options.company === undefined ? { companyId: COMPANY, organizationId: ORG } : options.company);
  const resolvePlatformCompanies = vi.fn(async () => options.companies ?? [{
    companyId: COMPANY, companyName: "North", organizationId: ORG, organizationName: "Group", countryCode: "CI",
  }]);
  const audit = vi.fn(options.audit ?? (async () => undefined));
  const hono = new Hono();
  hono.use("*", authMiddleware({
    mode: options.mode ?? "clerk",
    clerkSecretKey: "sk_test_example",
    authorizedParties: ["https://app.example"],
    resolveIdentity: async () => options.identity ?? ordinaryIdentity,
    clerkUserLookup: async () => null,
    resolvePlatformAdmin,
    resolvePlatformCompany,
    resolvePlatformCompanies,
    recordPlatformAccess: audit,
    ...(options.mode === "oidc" ? { issuer: "https://issuer.example", jwksUri: "https://issuer.example/jwks" } : {}),
  }));
  hono.route("/v1/platform", platformRoutes(resolvePlatformCompanies));
  hono.get("/v1/context", (c) => c.json(c.get("auth")));
  return { hono, resolvePlatformAdmin, resolvePlatformCompany, audit };
}

async function request(hono: Hono, path: string, tenant?: string) {
  return hono.request(path, {
    headers: {
      authorization: "Bearer session-token",
      ...(tenant ? { "x-tenant-id": tenant } : {}),
    },
  });
}

describe("Clerk platform administration", () => {
  beforeEach(() => {
    verifyToken.mockReset();
    verifyToken.mockResolvedValue({ sub: "clerk_admin", sid: "sess_1", fva: [0, 3] });
  });

  it("requires a Clerk second factor for every platform admin request", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "clerk_admin", sid: "sess_1", fva: [0, null] });
    expect((await request(app().hono, "/v1/platform/me")).status).toBe(403);
  });

  it("allows an active admin without company membership to discover the platform", async () => {
    const { hono } = app({ identity: { ...ordinaryIdentity, memberships: [] } });
    expect((await request(hono, "/v1/platform/me")).status).toBe(200);
    const response = await request(hono, "/v1/platform/companies");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ companies: [{ id: COMPANY, name: "North", organizationId: ORG, organizationName: "Group", countryCode: "CI" }] });
  });

  it("derives selected tenant organization from the admin DB callback", async () => {
    const selectedOrg = "66666666-6666-4666-8666-666666666666";
    const { hono } = app({ company: { companyId: FORGED, organizationId: selectedOrg } });
    const response = await request(hono, "/v1/context", FORGED);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenantId: FORGED, organizationId: selectedOrg, roles: ["OWNER"], platformAdmin: true });
  });

  it("rejects invalid and forged tenants before dispatch", async () => {
    const { hono, resolvePlatformCompany } = app({ company: null });
    expect((await request(hono, "/v1/context", "not-a-uuid")).status).toBe(403);
    expect((await request(hono, "/v1/context", FORGED)).status).toBe(403);
    expect(resolvePlatformCompany).toHaveBeenCalledTimes(1);
  });

  it("does not grant platform access to an ordinary Clerk user", async () => {
    const { hono } = app({ admin: null });
    expect((await request(hono, "/v1/platform/me", COMPANY)).status).toBe(403);
  });

  it("fails closed when platform access auditing fails", async () => {
    const { hono } = app({ audit: async () => { throw new Error("audit down"); } });
    expect((await request(hono, "/v1/platform/me")).status).toBe(503);
  });

  it("falls back to ordinary membership checks after platform revocation", async () => {
    const { hono } = app({ admin: null });
    expect((await request(hono, "/v1/context", COMPANY)).status).toBe(200);
    expect((await request(hono, "/v1/context", FORGED)).status).toBe(403);
  });

  it("does not elevate dev or OIDC authentication", async () => {
    const dev = app({ mode: "dev" }).hono;
    expect((await dev.request("/v1/platform/me", { headers: { "x-user-id": ADMIN_USER, "x-tenant-id": COMPANY } })).status).toBe(403);
    const oidc = app({ mode: "oidc" }).hono;
    expect((await oidc.request("/v1/platform/me", { headers: { authorization: "Bearer not-a-valid-token" } })).status).toBe(401);
  });
});