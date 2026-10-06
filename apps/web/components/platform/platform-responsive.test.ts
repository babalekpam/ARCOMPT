import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./platform.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../shell/shell.css", import.meta.url), "utf8");

describe("platform responsive styling contracts", () => {
  it("uses compact two-column mobile metrics with a full-width fifth metric", () => {
    expect(css).toMatch(/\.platform-stats\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/\.platform-stat:last-child\s*\{[^}]*grid-column: 1 \/ -1/);
    expect(css).toContain("repeat(5, minmax(0, 1fr))");
  });
  it("supports OS dark mode as well as the existing explicit dark class", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*--overview-surface: #142a30/);
    expect(css).toContain(".dark .platform-overview");
    expect(shell).toContain("@media (prefers-color-scheme: dark)");
    expect(shell).toContain(".dark .app-shell");
  });
  it("constrains the shell grid, account popup and safe-area navigation", () => {
    expect(shell).toContain("min-width: 0");
    expect(shell).toContain("max-width: calc(100vw - 2rem)");
    expect(shell).toContain("calc(4rem + env(safe-area-inset-bottom))");
    expect(shell).toContain("min-height: 100dvh");
  });
});
