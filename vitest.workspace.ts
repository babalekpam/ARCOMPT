import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  { test: { name: "ledger", root: "packages/ledger", include: ["src/**/*.test.ts"] } },
  { test: { name: "statements", root: "packages/statements", include: ["src/**/*.test.ts"] } },
  { test: { name: "rules", root: "packages/rules", include: ["src/**/*.test.ts"] } },
  { test: { name: "country-packs", root: "packages/country-packs", include: ["src/**/*.test.ts"] } },
  { test: { name: "ai-gateway", root: "packages/ai-gateway", include: ["src/**/*.test.ts"] } },
  { test: { name: "db", root: "packages/db", include: ["src/**/*.test.ts"], testTimeout: 30000 } },
  { test: { name: "api", root: "apps/api", include: ["src/**/*.test.ts"] } },
]);
