// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary

export type ClerkHosting = "managed" | "external";

export interface ClerkHostingEnv {
  CLERK_HOSTING?: string;
  NEXT_PUBLIC_CLERK_PROXY_URL?: string;
  VITE_CLERK_PROXY_URL?: string;
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
  return (
    env.NEXT_PUBLIC_CLERK_PROXY_URL?.trim() ||
    env.VITE_CLERK_PROXY_URL?.trim() ||
    (env.NODE_ENV === "production" && env.AUTH_MODE === "clerk" ? "/api/__clerk" : undefined)
  );
}