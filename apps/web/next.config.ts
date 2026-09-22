import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PWA : manifeste (app/manifest.ts), service worker (public/sw.js), page hors
  // ligne (public/offline.html) et enregistrement (components/pwa/ServiceWorkerRegistrar.tsx).
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000" },
};

export default nextConfig;
