import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock("@clerk/backend", () => ({
  verifyToken,
  createClerkClient: vi.fn(),
}));

import { authMiddleware } from "./auth.js";
import type { Identity } from "./identity.js";

const TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const identity = (over: Partial<Identity> = {}): Identity => ({
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  suspendedAt: null,
  mfaRequired: false,
  locale: null,
  memberships: [{ companyId: TENANT, role: "OWNER" }],
  ...over,
});

function app(
  resolve: (sub: string, hints: { email?: string; emailVerified?: boolean }) => Promise<Identity | null>,
  lookup: () => Promise<{ email?: string; emailVerified: boolean } | null> = async () => null,
) {
  const hono = new Hono();
  hono.use("*", authMiddleware({
    mode: "clerk",
    clerkSecretKey: "sk_test_example",
    authorizedParties: ["https://app.example"],
    resolveIdentity: resolve,
    clerkUserLookup: lookup,
  }));
  hono.get("/me", (c) => c.json(c.get("auth")));
  hono.get("/v1/session/memberships", (c) => c.json(c.get("auth")));
  return hono;
}

async function request(hono: Hono, tenant = TENANT, token = "session-token") {
  return hono.request("/me", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": tenant,
    },
  });
}

describe("Clerk API authentication", () => {
  beforeEach(() => {
    verifyToken.mockReset();
    verifyToken.mockResolvedValue({ sub: "user_clerk", sid: "sess_1", fva: [0, null] });
  });

  it("rejects a missing or invalid bearer token", async () => {
    const hono = app(async () => identity());
    expect((await hono.request("/me", { headers: { "x-tenant-id": TENANT } })).status).toBe(401);
    verifyToken.mockRejectedValueOnce(new Error("invalid"));
    expect((await request(hono)).status).toBe(401);
  });

  it("rejects a verified non-session token without sid", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "user_clerk", fva: [0, null] });
    expect((await request(app(async () => identity()))).status).toBe(401);
  });

  it("discovers only database memberships without a selected tenant", async () => {
    const hono = app(async () => identity({
      memberships: [{ companyId: TENANT, role: "OWNER" }, { companyId: OTHER, role: "REVIEWER" }],
    }));
    const headers = { authorization: "Bearer session-token" };
    const response = await hono.request("/v1/session/memberships", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ companies: [
      { id: TENANT, role: "OWNER" },
      { id: OTHER, role: "REVIEWER" },
    ], canBootstrap: false });
    expect((await hono.request("/me", { headers })).status).toBe(403);
    expect((await request(hono, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")).status).toBe(403);
  });

  it("shows no tenant access for an unlinked signup, never grants it", async () => {
    const hono = app(async () => null);
    const headers = { authorization: "Bearer session-token" };
    const response = await hono.request("/v1/session/memberships", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ companies: [], canBootstrap: false });
    expect((await hono.request("/me", { headers: { ...headers, "x-tenant-id": TENANT } })).status).toBe(403);
    expect((await hono.request("/v1/session/memberships")).status).toBe(401);
  });

  it("does not expose memberships for suspended or MFA-incomplete users", async () => {
    const headers = { authorization: "Bearer session-token" };
    const suspended = await app(async () => identity({ suspendedAt: new Date() }))
      .request("/v1/session/memberships", { headers });
    expect(suspended.status).toBe(403);
    expect(((await suspended.json()) as { error: { code: string } }).error.code).toBe("ACCOUNT_SUSPENDED");
    const mfa = await app(async () => identity({ mfaRequired: true }))
      .request("/v1/session/memberships", { headers });
    expect(mfa.status).toBe(403);
    expect(((await mfa.json()) as { error: { code: string } }).error.code).toBe("MFA_REQUIRED");
  });

  it("keeps tenant authorization in the database", async () => {
    const hono = app(async () => identity());
    expect((await request(hono, OTHER)).status).toBe(403);
  });

  it("does not link an unknown user from an unverified Clerk email", async () => {
    const resolve = vi.fn(async () => null);
    const lookup = vi.fn(async () => ({ email: "owner@example.com", emailVerified: false }));
    expect((await request(app(resolve, lookup))).status).toBe(403);
    expect(lookup).toHaveBeenCalledWith("user_clerk");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("links only an explicitly verified primary email on first login", async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identity());
    const lookup = vi.fn(async () => ({ email: "owner@example.com", emailVerified: true }));
    expect((await request(app(resolve, lookup))).status).toBe(200);
    expect(resolve).toHaveBeenLastCalledWith("user_clerk", { email: "owner@example.com", emailVerified: true });
  });

  it("fails closed for MFA until Clerk fva proves a second factor", async () => {
    const hono = app(async () => identity({ mfaRequired: true }));
    expect((await request(hono)).status).toBe(403);
    verifyToken.mockResolvedValueOnce({ sub: "user_clerk", sid: "sess_1", fva: [0, 12] });
    expect((await request(hono)).status).toBe(200);
    verifyToken.mockResolvedValueOnce({ sub: "user_clerk", sid: "sess_1", fva: ["pwd", "otp"] });
    expect((await request(hono)).status).toBe(403);
  });
});