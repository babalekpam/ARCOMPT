// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { publishableKeyFromHost } from "@clerk/shared/keys";

export type ClerkHosting = "managed" | "external";

export interface ClerkHostingEnv {
  CLERK_HOSTING?: string;
  NEXT_PUBLIC_CLERK_PROXY_URL?: string;
  VITE_CLERK_PROXY_URL?: string;
  CLERK_PROXY_URL?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  VITE_CLERK_PUBLISHABLE_KEY?: string;
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
  NODE_ENV?: string;
  AUTH_MODE?: string;
}

/** Unset remains Replit-managed for backward compatibility. */
export function parseClerkHosting(value: string | undefined): ClerkHosting {
  const normalized = value?.trim() || "managed";
  if (normalized === "managed" || normalized === "external") return normalized;
  throw new Error(`CLERK_HOSTING must be "managed" or "external", received "${normalized}"`);
}

/**
 * External Clerk tenants are contacted directly through the Frontend API
 * encoded in their publishable key. They must never inherit Replit's proxy.
 */
export function clerkProxyUrl(env: ClerkHostingEnv): string | undefined {
  if (parseClerkHosting(env.CLERK_HOSTING) === "external") return undefined;
  // Empty in development is intentional. Never manufacture a production URL.
  return env.VITE_CLERK_PROXY_URL ?? env.CLERK_PROXY_URL ?? env.NEXT_PUBLIC_CLERK_PROXY_URL ?? "";
}

/** Match the canonical proxy's first effective forwarded host; strip ports. */
export function clerkHostname(headers: Pick<Headers, "get">): string {
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host")?.trim() || "";
  if (!host) return "";
  try { return new URL(`https://${host}`).hostname; } catch { return ""; }
}

export function clerkPublishableKey(hostname: string, env: ClerkHostingEnv): string {
  const fallback = env.CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  return parseClerkHosting(env.CLERK_HOSTING) === "external" ? fallback : publishableKeyFromHost(hostname, fallback);
}