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
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000" },
};

export default nextConfig;
