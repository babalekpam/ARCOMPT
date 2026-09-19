import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "web",
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
