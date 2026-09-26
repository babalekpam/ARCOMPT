import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-shared";
const { getAuthContext, apiFetch } = vi.hoisted(() => ({ getAuthContext: vi.fn(), apiFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext, UUID_RE: /^[0-9a-f-]{36}$/i }));
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), apiFetch }));
import { GET, POST } from "./route";
const tenant = "00000000-0000-4000-8000-000000000001";
const url = "https://arcompt.example/api/session/admin-mode";
function request(action: string, origin = "https://arcompt.example", saved?: string) {
  const r = new NextRequest(url, { method: "POST", headers: { origin, "content-type": "application/json", "x-arcompt-admin-mode": "forged" }, body: JSON.stringify({ action }) });
  if (saved) r.cookies.set("arcompt_customer_tenant", saved);
  return r;
}
describe("server-only administrator mode cookie", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAuthContext.mockResolvedValue({ userId: "customer", sessionId: "session", tenantId: tenant, headers: { Authorization: "Bearer server" } });
  });
  it("rejects cross-origin changes and unknown actions before the API", async () => {
    expect((await POST(request("activate", "https://evil.example"))).status).toBe(403);
    expect((await POST(request("constructor"))).status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it("consumes the token server-side, saves the customer selection and clears the admin selection", async () => {
    apiFetch.mockResolvedValue({ token: "a".repeat(43), expiresAt: new Date(Date.now()+600000).toISOString() });
    const r = await POST(request("activate"));
    expect(r.status).toBe(200);
    expect(await r.json()).not.toHaveProperty("token");
    expect(r.cookies.get("arcompt_admin_mode")).toMatchObject({ value: "a".repeat(43), httpOnly: true, sameSite: "lax" });
    expect(JSON.parse(r.cookies.get("arcompt_customer_tenant")!.value)).toEqual({ sub: "customer", sid: "session", tenant });
    expect(r.cookies.get("arcompt_customer_tenant")!.maxAge).toBeGreaterThan(r.cookies.get("arcompt_admin_mode")!.maxAge!);
    expect(r.cookies.get("arcompt_tenant")?.maxAge).toBe(0);
    expect(apiFetch).toHaveBeenCalledWith("/security/admin-mode/activate", { method: "POST", body: {}, headers: { "X-Tenant-Id": "" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("deactivates on the API before removing the cookie and restores only this user's tenant", async () => {
    apiFetch.mockResolvedValue({ active: false });
    const r = await POST(request("deactivate", undefined, JSON.stringify({ sub: "customer", sid: "session", tenant })));
    expect(r.cookies.get("arcompt_admin_mode")?.maxAge).toBe(0);
    expect(r.cookies.get("arcompt_customer_tenant")?.maxAge).toBe(0);
    expect(r.cookies.get("arcompt_tenant")?.value).toBe(tenant);
    const wrong = await POST(request("deactivate", undefined, JSON.stringify({ sub: "different", tenant })));
    expect(wrong.cookies.get("arcompt_tenant")?.value).toBe("");
    const newSession = await POST(request("deactivate", undefined, JSON.stringify({ sub: "customer", sid: "old_session", tenant })));
    expect(newSession.cookies.get("arcompt_tenant")?.value).toBe("");
  });
  it("does not replace the original customer selection when renewing mode", async () => {
    apiFetch.mockResolvedValue({ token: "b".repeat(43), expiresAt: new Date(Date.now()+600000).toISOString() });
    const r = await POST(request("activate", undefined, JSON.stringify({ sub: "customer", sid: "session", tenant })));
    expect(r.cookies.get("arcompt_customer_tenant")).toBeUndefined();
  });
  it("does not preserve a prior session's administrative selection on reactivation", async () => {
    apiFetch.mockResolvedValue({ token: "b".repeat(43), expiresAt: new Date(Date.now()+600000).toISOString() });
    const r = await POST(request("activate", undefined, JSON.stringify({ sub: "customer", sid: "old_session", tenant })));
    expect(JSON.parse(r.cookies.get("arcompt_customer_tenant")!.value)).toEqual({ sub: "customer", sid: "session", tenant: null });
  });
  it("fails closed on MFA refusal, malformed tokens, expiry and upstream outage", async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(403, "MFA_REQUIRED", "Vérifiez votre authentificateur"));
    expect((await POST(request("activate"))).status).toBe(403);
    for (const data of [
      { token: "true", expiresAt: new Date(Date.now()+60000).toISOString() },
      { token: "a".repeat(43), expiresAt: "invalid" },
      { token: "a".repeat(43), expiresAt: new Date(Date.now()-1000).toISOString() },
    ]) {
      apiFetch.mockResolvedValueOnce(data);
      expect((await POST(request("activate"))).cookies.get("arcompt_admin_mode")).toBeUndefined();
    }
    apiFetch.mockRejectedValueOnce(new Error("outage"));
    expect((await POST(request("deactivate"))).status).toBe(503);
  });
  it("returns status without exposing proof/token material", async () => {
    apiFetch.mockResolvedValue({ eligible: true, active: false, expiresAt: null });
    expect(await (await GET(new NextRequest(url))).json()).toEqual({ eligible: true, active: false, expiresAt: null, canReturn: false });
    getAuthContext.mockResolvedValue(null);
    expect((await GET(new NextRequest(url))).status).toBe(401);
  });
});