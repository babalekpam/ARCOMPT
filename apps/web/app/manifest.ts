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
    icons: [],
  };
}
