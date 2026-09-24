// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { clerkProxyUrl, parseClerkHosting } from "./clerk-hosting";

describe("Clerk hosting", () => {
  it("preserves the managed production proxy default", () => {
    expect(clerkProxyUrl({ NODE_ENV: "production", AUTH_MODE: "clerk" })).toBe("/api/__clerk");
  });

  it("preserves an explicitly provisioned managed proxy", () => {
    expect(clerkProxyUrl({ CLERK_HOSTING: "managed", VITE_CLERK_PROXY_URL: " /managed-clerk " })).toBe("/managed-clerk");
  });

  it("omits every proxy in external mode", () => {
    expect(clerkProxyUrl({
      CLERK_HOSTING: "external",
      NODE_ENV: "production",
      AUTH_MODE: "clerk",
      NEXT_PUBLIC_CLERK_PROXY_URL: "/api/__clerk",
      VITE_CLERK_PROXY_URL: "/managed-clerk",
    })).toBeUndefined();
  });

  it("fails closed for unknown hosting modes", () => {
    expect(() => parseClerkHosting("externl")).toThrow(/CLERK_HOSTING/);
  });
});