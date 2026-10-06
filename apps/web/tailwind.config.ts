// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Palette de marque — relevée sur le logo fourni, voir docs/BRAND.md.
        // Les neutres restent l'échelle `slate` de Tailwind, déjà employée
        // partout dans l'interface.
        brand: {
          DEFAULT: "#0F2A43", // marine — rubans du logo, teinte dominante ; 13,2:1 sur blanc
          petrol: "#1B4F72", // bleu pétrole — corps de la calculatrice ; 5,2:1 sur blanc
          teal: "#0E9F6E", // turquoise — histogramme ; 2,8:1 sur blanc, jamais du texte
          light: "#0E9F6E", // alias de `teal` pour les fonds sombres (7,2:1 sur slate-950)
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
