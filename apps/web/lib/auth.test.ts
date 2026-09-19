import { describe, expect, it } from "vitest";
import { buildHeaders, parseDevCookie } from "./auth";

describe("en-têtes d'authentification", () => {
  it("mode dev : X-User-Id / X-Tenant-Id / X-Organization-Id", () => {
    expect(buildHeaders({ mode: "dev", userId: "demo", tenantId: "t1", organizationId: "o1" })).toEqual({ "X-User-Id": "demo", "X-Tenant-Id": "t1", "X-Organization-Id": "o1" });
    expect(buildHeaders({ mode: "dev", userId: "demo", tenantId: null })).toEqual({ "X-User-Id": "demo" });
  });

  it("mode oidc : Bearer + dossier choisi, jamais de X-User-Id", () => {
    const h = buildHeaders({ mode: "oidc", userId: "ignored", tenantId: "t1", accessToken: "tok" });
    expect(h).toEqual({ Authorization: "Bearer tok", "X-Tenant-Id": "t1" });
  });

  it("lit le cookie dev et rejette les valeurs invalides", () => {
    expect(parseDevCookie(JSON.stringify({ userId: "u", tenantId: "t", organizationId: "o" }))).toEqual({ userId: "u", tenantId: "t", organizationId: "o" });
    expect(parseDevCookie(JSON.stringify({ tenantId: "t" }))).toBeNull();
    expect(parseDevCookie("{oops")).toBeNull();
    expect(parseDevCookie(undefined)).toBeNull();
  });
});
