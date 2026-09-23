import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Palette de marque — voir docs/BRAND.md. Les neutres restent l'échelle
        // `slate` de Tailwind, déjà employée partout dans l'interface.
        brand: {
          DEFAULT: "#0E5B46", // vert registre — marque et accents sur fond clair
          light: "#4FB795", // vert registre clair — marque et accents sur fond sombre
          ocre: "#C2703D", // ocre latérite — seconde teinte, jamais du texte courant
          "ocre-light": "#D98A55",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
