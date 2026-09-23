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
    // Marque ARCOMPT (voir docs/BRAND.md). Le logo est une image matricielle :
    // pas de variante SVG, les PNG sont dérivés de `public/brand/arcompt-mark-512.png`.
    // Tous portent une plaque blanche, car le marine du logo disparaît sur fond
    // sombre. `maskable` est à fond perdu et n'occupe que 58 % de la toile, pour
    // tenir dans les 80 % centraux que le masque Android laisse voir.
    icons: [
      { src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
