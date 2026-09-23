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
          DEFAULT: "#14324E", // marine — rubans du logo, teinte dominante ; 13,2:1 sur blanc
          petrol: "#0A7693", // bleu pétrole — corps de la calculatrice ; 5,2:1 sur blanc
          teal: "#1BAD9A", // turquoise — histogramme ; 2,8:1 sur blanc, jamais du texte
          light: "#1BAD9A", // alias de `teal` pour les fonds sombres (7,2:1 sur slate-950)
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
