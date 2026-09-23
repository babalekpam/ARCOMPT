import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ARCOMPT",
    short_name: "ARCOMPT",
    description: "La comptabilité intelligente des PME de l'espace OHADA",
    start_url: "/",
    display: "standalone",
    lang: "fr",
    background_color: "#ffffff",
    theme_color: "#0f172a",
    // Marque ARCOMPT (voir docs/BRAND.md). Les PNG sont rendus depuis
    // `public/favicon.svg` ; `maskable` porte la marge de sécurité Android
    // (marque inscrite dans les 80 % centraux) pour survivre au masquage.
    icons: [
      { src: "/favicon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
