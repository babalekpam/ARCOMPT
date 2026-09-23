// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Sortie autonome : l'image de production n'embarque que le serveur et ses
  // dépendances tracées, pas l'arbre de développement. C'est le réglage
  // officiel, à préférer à la variable privée NEXT_PRIVATE_STANDALONE que le
  // Dockerfile utilisait faute de pouvoir modifier ce fichier — cette variable
  // serait d'ailleurs silencieusement neutralisée par toute valeur d'`output`
  // posée ici.
  output: "standalone",
  // PWA : manifeste (app/manifest.ts), service worker (public/sw.js), page hors
  // ligne (public/offline.html) et enregistrement (components/pwa/ServiceWorkerRegistrar.tsx).
  // Clerk's publishable key is intentionally public; provisioned Replit
  // secrets expose it under VITE_*, while Next client components use NEXT_PUBLIC_*.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY ?? "",
    // The managed Vite variable may only be injected at publish time. Next
    // embeds public env at BUILD time, so use our actual App Router proxy route
    // when building for Clerk production rather than silently bypassing it.
    NEXT_PUBLIC_CLERK_PROXY_URL:
      process.env.NEXT_PUBLIC_CLERK_PROXY_URL?.trim() ||
      process.env.VITE_CLERK_PROXY_URL?.trim() ||
      (process.env.NODE_ENV === "production" && process.env.AUTH_MODE === "clerk" ? "/api/__clerk" : ""),
    NEXT_PUBLIC_AUTH_MODE: process.env.AUTH_MODE ?? "dev",
  },
};

export default nextConfig;
