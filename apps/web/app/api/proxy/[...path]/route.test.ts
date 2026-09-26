import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { acceptsMutationOrigin } from "@/lib/proxy-origin";

vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn().mockResolvedValue({ headers: {} }) }));
import { GET } from "./route";
const request = (headers: Record<string, string>) => new NextRequest("https://internal.example/api/proxy/session/bootstrap", { method: "POST", headers });

describe("authenticated API proxy mutation origin", () => {
  it("accepts browser requests from the same origin", () => {
    expect(acceptsMutationOrigin(request({ "sec-fetch-site": "same-origin", origin: "https://app.example" }))).toBe(true);
  });

  it("rejects same-site sibling origins and cross-site requests", () => {
    expect(acceptsMutationOrigin(request({ "sec-fetch-site": "same-site", origin: "https://other.example" }))).toBe(false);
    expect(acceptsMutationOrigin(request({ "sec-fetch-site": "cross-site", origin: "https://external.example" }))).toBe(false);
  });

  it("checks explicit Origin when a client does not send Fetch Metadata", () => {
    expect(acceptsMutationOrigin(request({ origin: "https://internal.example" }))).toBe(true);
    expect(acceptsMutationOrigin(request({ origin: "https://other.example" }))).toBe(false);
  });
});

describe("MFA proof isolation", () => {
  it("rejects normalized traversal paths which could bypass token endpoint isolation", async () => {
    const res = await GET(new NextRequest("https://internal.example/api/proxy/anything"), { params: Promise.resolve({ path: ["anything", "..", "security", "admin-mode", "activate"] }) });
    expect(res.status).toBe(404);
  });
  it("blocks raw administrator activation tokens through the generic proxy", async () => {
    const res = await GET(new NextRequest("https://internal.example/api/proxy/security/admin-mode/activate"), { params: Promise.resolve({ path: ["security", "admin-mode", "activate"] }) });
    expect(res.status).toBe(404);
  });
  it("blocks access to MFA responses through the generic proxy", async () => {
    const res = await GET(new NextRequest("https://internal.example/api/proxy/security/mfa/confirm"), { params: Promise.resolve({ path: ["security", "mfa", "confirm"] }) });
    expect(res.status).toBe(404);
  });
});