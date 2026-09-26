// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { clerkHostname, clerkPublishableKey, clerkProxyUrl, parseClerkHosting } from "./clerk-hosting";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("Clerk hosting", () => {
  it("does not invent a proxy in either environment", () => {
    for (const NODE_ENV of ["development", "production"]) {
      expect(clerkProxyUrl({ NODE_ENV, AUTH_MODE: "clerk" })).toBe("");
    }
  });

  it("preserves an explicitly provisioned managed proxy", () => {
    expect(clerkProxyUrl({ CLERK_HOSTING: "managed", VITE_CLERK_PROXY_URL: "/managed-clerk" })).toBe("/managed-clerk");
    expect(clerkProxyUrl({ VITE_CLERK_PROXY_URL: "", NEXT_PUBLIC_CLERK_PROXY_URL: "/stale" })).toBe("");
    expect(clerkProxyUrl({ CLERK_PROXY_URL: "/injected-at-runtime" })).toBe("/injected-at-runtime");
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

  it("keeps the provisioned development key regardless of preview host", () => {
    const key = `pk_test_${Buffer.from("fixture.clerk.accounts.dev$").toString("base64")}`;
    expect(clerkPublishableKey("localhost", { CLERK_PUBLISHABLE_KEY: key })).toBe(key);
    expect(clerkPublishableKey("preview.replit.dev", { VITE_CLERK_PUBLISHABLE_KEY: key })).toBe(key);
  });

  it("derives live keys per request host, not the build's stale domain", () => {
    const oldKey = `pk_live_${Buffer.from("clerk.old.example$").toString("base64")}`;
    for (const hostname of ["www.example.com", "example.replit.app"]) {
      const key = clerkPublishableKey(hostname, { CLERK_PUBLISHABLE_KEY: oldKey });
      expect(Buffer.from(key.slice("pk_live_".length), "base64").toString()).toBe(`clerk.${hostname}$`);
    }
    expect(clerkPublishableKey("www.example.com", { CLERK_HOSTING: "external", CLERK_PUBLISHABLE_KEY: oldKey })).toBe(oldKey);
  });

  it("uses the same first effective forwarded hostname as the canonical proxy", () => {
    expect(clerkHostname(new Headers({ "x-forwarded-host": "www.example.com:443, internal:3000", host: "localhost:3000" }))).toBe("www.example.com");
    expect(clerkHostname(new Headers({ host: "localhost:3000" }))).toBe("localhost");
  });

  it("preserves path-routed Google callbacks and the escaped proxy route", () => {
    const web = fileURLToPath(new URL("../", import.meta.url));
    for (const route of ["app/login/[[...path]]/page.tsx", "app/sign-up/[[...path]]/page.tsx", "app/api/%5F%5Fclerk/[[...path]]/route.ts"]) {
      expect(existsSync(`${web}${route}`)).toBe(true);
    }
    const signIn = readFileSync(`${web}components/login/ClerkSignIn.tsx`, "utf8");
    expect(signIn).toContain('routing="path"');
    expect(signIn).toContain('path="/login"');
    expect(signIn).toContain("/api/session/landing");
  });
});