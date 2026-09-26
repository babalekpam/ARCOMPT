import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-shared";

const { getAuthContext, apiFetch } = vi.hoisted(() => ({ getAuthContext: vi.fn(), apiFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, apiFetch };
});
import { GET, POST } from "./route";

const url = "https://arcompt.example/api/session/mfa";
const request = (body: unknown, headers: Record<string, string> = { origin: "https://arcompt.example" }) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("app-owned MFA session endpoint", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAuthContext.mockResolvedValue({ userId: "user", headers: { Authorization: "Bearer server" } });
  });

  it("checks origin before authentication and never forwards browser MFA headers", async () => {
    const denied = await POST(request({ action: "verify", code: "123456" }, { origin: "https://other.example", "x-arcompt-mfa": "forged" }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(apiFetch).not.toHaveBeenCalled();
    apiFetch.mockResolvedValue({ proof: "opaque", expiresAt: new Date(Date.now() + 600000).toISOString() });
    await POST(request({ action: "verify", code: "123456" }, { origin: "https://arcompt.example", "x-arcompt-mfa": "forged" }));
    expect(apiFetch).toHaveBeenCalledWith("/security/mfa/verify", {
      method: "POST", body: { code: "123456" }, headers: { "X-Tenant-Id": "" },
    });
  });

  it("strips opaque proof from JSON and sets httpOnly cookie expiring with proof", async () => {
    apiFetch.mockResolvedValue({ proof: "opaque-server-value", expiresAt: new Date(Date.now() + 600000).toISOString(), recoveryCodes: ["one"] });
    const res = await POST(request({ action: "confirm", code: "123456" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ recoveryCodes: ["one"] });
    expect(JSON.stringify(body)).not.toContain("opaque-server-value");
    expect(res.cookies.get("arcompt_mfa")?.value).toBe("opaque-server-value");
    expect(res.headers.get("set-cookie")).toMatch(/httponly/i);
    expect(res.headers.get("set-cookie")).toMatch(/samesite=lax/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("passes backend refusal to caller without creating MFA proof", async () => {
    apiFetch.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Trop de tentatives"));
    const res = await POST(request({ action: "verify", code: "123456" }));
    expect(res.status).toBe(429);
    expect(res.cookies.get("arcompt_mfa")).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects inherited action names rather than sending an undefined path upstream", async () => {
    for (const action of ["toString", "constructor", "__proto__"]) {
      const res = await POST(request({ action, code: "123456" }));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("supports recovery codes for verification, but rotation needs a fresh TOTP", async () => {
    apiFetch.mockResolvedValue({ proof: "x", expiresAt: new Date(Date.now() + 600000).toISOString() });
    expect((await POST(request({ action: "verify", code: "ABCD-1234" }))).status).toBe(200);
    expect((await POST(request({ action: "recovery-codes", code: "ABCD-1234" }))).status).toBe(400);
  });

  it("clears an existing MFA cookie after recovery-code regeneration", async () => {
    apiFetch.mockResolvedValue({ recoveryCodes: ["new-one"] });
    const res = await POST(request({ action: "recovery-codes", code: "123456" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recoveryCodes: ["new-one"] });
    expect(res.cookies.get("arcompt_mfa")?.value).toBe("");
    expect(res.cookies.get("arcompt_mfa")?.maxAge).toBe(0);
  });

  it("does not cache unauthenticated or configuration-error responses", async () => {
    getAuthContext.mockResolvedValueOnce(null);
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
    apiFetch.mockRejectedValueOnce(new Error("configuration"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await res.json())).not.toContain("SESSION_SECRET");
  });

  it("queries status without a tenant and requires a signed-in user", async () => {
    apiFetch.mockResolvedValue({ enabled: true, verified: false });
    expect(await (await GET()).json()).toEqual({ enabled: true, verified: false });
    expect(apiFetch).toHaveBeenCalledWith("/security/mfa/status", { headers: { "X-Tenant-Id": "" } });
    getAuthContext.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});