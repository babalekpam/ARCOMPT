// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { NextConfig } from "next";
import { clerkProxyUrl, parseClerkHosting } from "./lib/clerk-hosting";

const clerkHosting = parseClerkHosting(process.env.CLERK_HOSTING);
const resolvedClerkProxyUrl = clerkProxyUrl(process.env);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Replit's VM starts this app with `next start` from the workspace. Keep
  // Next's standard build output so that runtime and /_next/static agree.
  // PWA : manifeste (app/manifest.ts), service worker (public/sw.js), page hors
  // ligne (public/offline.html) et enregistrement (components/pwa/ServiceWorkerRegistrar.tsx).
  // Clerk's publishable key is intentionally public; provisioned Replit
  // secrets expose it under VITE_*, while Next client components use NEXT_PUBLIC_*.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY ?? "",
    // External tenants use the Frontend API encoded in their publishable key.
    // Managed builds retain Replit's proxy and same-origin production default.
    NEXT_PUBLIC_CLERK_HOSTING: clerkHosting,
    NEXT_PUBLIC_CLERK_PROXY_URL: resolvedClerkProxyUrl ?? "",
    NEXT_PUBLIC_AUTH_MODE: process.env.AUTH_MODE ?? "dev",
  },
};

export default nextConfig;
