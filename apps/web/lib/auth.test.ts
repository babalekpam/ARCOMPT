// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { buildHeaders, parseDevCookie } from "./auth";

describe("en-têtes d'authentification", () => {
  it("mode dev : X-User-Id / X-Tenant-Id / X-Organization-Id", () => {
    expect(buildHeaders({ mode: "dev", userId: "demo", tenantId: "t1", organizationId: "o1" })).toEqual({ "X-User-Id": "demo", "X-Tenant-Id": "t1", "X-Organization-Id": "o1" });
    expect(buildHeaders({ mode: "dev", userId: "demo", tenantId: null })).toEqual({ "X-User-Id": "demo" });
  });

  it("mode oidc : Bearer + dossier choisi, jamais de X-User-Id", () => {
    const h = buildHeaders({ mode: "clerk", userId: "ignored", tenantId: "t1", accessToken: "tok" });
    expect(h).toEqual({ Authorization: "Bearer tok", "X-Tenant-Id": "t1" });
  });

  it("ne transmet la preuve MFA que depuis le contexte serveur", () => {
    expect(buildHeaders({ mode: "clerk", accessToken: "tok", mfaProof: "opaque" })).toEqual({
      Authorization: "Bearer tok", "X-Arcompt-Mfa": "opaque",
    });
    expect(buildHeaders({ mode: "dev", userId: "u" })).not.toHaveProperty("X-Arcompt-Mfa");
  });
  it("forwards admin mode only from the server cookie context", () => {
    expect(buildHeaders({ mode: "clerk", accessToken: "tok", adminMode: "opaque-mode" })).toEqual({
      Authorization: "Bearer tok", "X-Arcompt-Admin-Mode": "opaque-mode",
    });
  });
  it("forwards the deny-only tombstone even when the short-lived mode token cookie has expired", () => {
    expect(buildHeaders({ mode: "clerk", accessToken: "tok", adminModeExpected: true })).toEqual({
      Authorization: "Bearer tok", "X-Arcompt-Admin-Mode-Expected": "1",
    });
  });

  it("lit le cookie dev et rejette les valeurs invalides", () => {
    expect(parseDevCookie(JSON.stringify({ userId: "u", tenantId: "t", organizationId: "o" }))).toEqual({ userId: "u", tenantId: "t", organizationId: "o" });
    expect(parseDevCookie(JSON.stringify({ tenantId: "t" }))).toBeNull();
    expect(parseDevCookie("{oops")).toBeNull();
    expect(parseDevCookie(undefined)).toBeNull();
  });
});
