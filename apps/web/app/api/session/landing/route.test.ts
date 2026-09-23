import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-shared";

const { getAuthContext, apiTry } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  apiTry: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, apiTry };
});

import { GET } from "./route";

const TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const req = () => new NextRequest("https://app.example/api/session/landing");
const destination = (res: Response) => new URL(res.headers.get("location")!, "https://app.example").pathname;

describe("post-login account routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAuthContext.mockResolvedValue({ mode: "clerk", tenantId: null });
  });

  it("sends a verified platform admin to /platform and clears an old tenant", async () => {
    getAuthContext.mockResolvedValue({ mode: "clerk", tenantId: OTHER });
    apiTry.mockResolvedValueOnce({ ok: true, data: { platformAdmin: true } });
    const res = await GET(req());
    expect(destination(res)).toBe("/platform");
    expect(res.cookies.get("arcompt_tenant")?.value).toBe("");
    expect(apiTry).toHaveBeenCalledWith("/platform/me", { headers: { "X-Tenant-Id": "" } });
    expect(apiTry).toHaveBeenCalledTimes(1);
  });

  it("selects a verified membership for a regular user and preserves an allowed selection", async () => {
    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: true, data: { companies: [{ id: TENANT, role: "OWNER" }, { id: OTHER, role: "REVIEWER" }] } });
    const first = await GET(req());
    expect(destination(first)).toBe("/dashboard");
    expect(first.cookies.get("arcompt_tenant")?.value).toBe(TENANT);
    expect(apiTry).toHaveBeenNthCalledWith(2, "/session/memberships", { headers: { "X-Tenant-Id": "" } });

    getAuthContext.mockResolvedValue({ mode: "clerk", tenantId: OTHER });
    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: true, data: { companies: [{ id: TENANT }, { id: OTHER }] } });
    const retained = await GET(req());
    expect(destination(retained)).toBe("/dashboard");
    expect(retained.cookies.get("arcompt_tenant")).toBeUndefined();
  });

  it("never reuses another account's cookie and gives an unlinked user no access", async () => {
    getAuthContext.mockResolvedValue({ mode: "clerk", tenantId: OTHER });
    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: true, data: { companies: [{ id: TENANT }] } });
    expect((await GET(req())).cookies.get("arcompt_tenant")?.value).toBe(TENANT);

    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: true, data: { companies: [] } });
    const empty = await GET(req());
    expect(destination(empty)).toBe("/access-pending");
    expect(empty.cookies.get("arcompt_tenant")?.value).toBe("");
  });

  it("offers self-service company creation only when the API verifies eligibility", async () => {
    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: true, data: { companies: [], canBootstrap: true } });
    expect(destination(await GET(req()))).toBe("/onboarding");

    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: true, data: { companies: [], canBootstrap: false } });
    expect(destination(await GET(req()))).toBe("/access-pending");
  });

  it("fails closed when the role lookup is unavailable", async () => {
    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(503, "UNAVAILABLE", "DB down") });
    const res = await GET(req());
    expect(destination(res)).toBe("/access-pending");
    expect(apiTry).toHaveBeenCalledTimes(1);
  });

  it("explains expired sessions, suspension and MFA instead of calling them outages", async () => {
    for (const [error, reason] of [
      [new ApiError(401, "UNAUTHORIZED", "Invalid session"), "session"],
      [new ApiError(403, "ACCOUNT_SUSPENDED", "Suspended"), "suspended"],
      [new ApiError(403, "MFA_REQUIRED", "Second factor needed"), "mfa"],
    ] as const) {
      apiTry.mockResolvedValueOnce({ ok: false, error });
      const res = await GET(req());
      expect(destination(res)).toBe("/access-pending");
      expect(new URL(res.headers.get("location")!, "https://app.example").searchParams.get("reason")).toBe(reason);
    }
  });

  it("preserves a tenant discovery denial instead of reporting a service outage", async () => {
    apiTry.mockResolvedValueOnce({ ok: false, error: new ApiError(403, "FORBIDDEN", "Not admin") })
      .mockResolvedValueOnce({ ok: false, error: new ApiError(403, "ACCOUNT_SUSPENDED", "Suspended") });
    const res = await GET(req());
    expect(new URL(res.headers.get("location")!, "https://app.example").searchParams.get("reason")).toBe("suspended");
  });

  it("sends unauthenticated visitors to login", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(req());
    expect(destination(res)).toBe("/login");
    expect(res.headers.get("location")).toBe("/login");
  });
});