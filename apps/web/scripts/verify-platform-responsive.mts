/**
 * Disposable signed-in presentation harness. Never registers an application
 * route or changes auth. All auth/i18n server dependencies and API responses
 * are mocked in a Vite process rooted in /tmp; real shell/pages are imported.
 * Run from workspace: pnpm exec tsx apps/web/scripts/verify-platform-responsive.mts
 * Add --serve to leave the local-only harness running for visual inspection.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import tailwindConfig from "../tailwind.config";

const web = fileURLToPath(new URL("..", import.meta.url));
const requireWeb = createRequire(resolve(web, "package.json"));
const root = await mkdtemp(resolve(tmpdir(), "arcompt-platform-"));
const shots = resolve(root, "screenshots");
await mkdir(shots);
const mock = resolve(root, "mocks.tsx");
const overview = {
  totals: { organizations: 7, companies: 13, users: 38, activeUsers: 35, suspendedUsers: 3 },
  organizations: [
    { id: "cabinet-reference-longue-123456789", name: "Cabinet Ndiaye & Associés", kind: "FIRM", plan: "PRO", users: 17, activeUsers: 16, suspendedUsers: 1,
      companies: [{ id: "f3fbd0ee-42e1-4a2a-9a74-6064e480df28", name: "Société de transport du littoral", countryCode: "SN" }] },
    { id: "organization-reference-987654321", name: "Atelier Diarra", kind: "COMPANY", plan: "TRIAL", users: 4, activeUsers: 3, suspendedUsers: 1, companies: [] },
  ],
};
const ai = {
  revision: 11, defaultProvider: "anthropic", captureProvider: "openai", categorizeProvider: "gemini", encryptionAvailable: true,
  providers: [
    { id: "anthropic", name: "Anthropic", model: "claude-custom", source: "stored", configured: true },
    { id: "openai", name: "OpenAI", model: "gpt-custom", source: "environment", configured: true },
    { id: "gemini", name: "Gemini", model: "gemini-custom", source: "none", configured: false },
  ],
};
await writeFile(mock, `
import React from "react";
import { getMessages } from "${web}/lib/i18n";
const messages = getMessages("fr");
const t = (key) => messages[key] ?? key;
export const useT = () => t;
export const useI18n = () => ({ locale: "fr", t });
export const getT = async () => ({ t });
export const usePathname = () => location.pathname;
export const useRouter = () => ({ push: (url) => location.assign(url), refresh: () => {} });
export const redirect = (url) => { throw new Error("Unexpected guard redirect: " + url); };
export const useClerk = () => ({ signOut: () => {} });
export const getPlatformAdmin = async () => true;
export const getCurrentMemberReference = async () => "Référence de test";
export const requireAuthContext = async () => ({ mode: "clerk", tenantId: "f3fbd0ee-42e1-4a2a-9a74-6064e480df28" });
export const apiTry = async () => new URLSearchParams(location.search).has("error") ? { ok: false } : { ok: true, data: ${JSON.stringify(overview)} };
export const getOfflineServices = async () => null;
export const resetOfflineServices = () => {};
export default function Link({ href, children, prefetch, ...props }) { return <a href={href} {...props}>{children}</a>; }
`);
await writeFile(resolve(root, "index.html"), '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ARCOMPT · harness privé</title><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(resolve(root, "entry.tsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import "${web}/app/globals.css";
import { AppShell } from "${web}/components/shell/AppShell";
import PlatformPage from "${web}/app/(app)/platform/page";
import PlatformAiPage from "${web}/app/(app)/platform/ai/page";
import PlatformLoading from "${web}/app/(app)/platform/loading";
const params = new URLSearchParams(location.search);
const auth = { mode: "clerk", tenantId: "f3fbd0ee-42e1-4a2a-9a74-6064e480df28" };
const content = params.has("loading") ? <PlatformLoading /> : await (location.pathname === "/platform/ai" ? PlatformAiPage() : PlatformPage());
createRoot(document.getElementById("root")).render(await AppShell({ auth, children: content }));
`);
const aliases = ["next/link", "next/navigation", "@clerk/nextjs", "@/lib/i18n-client", "@/lib/i18n-server", "@/lib/auth", "@/lib/platform", "@/lib/api", "@/lib/member-reference", "@/lib/offline-browser"];
const server = await createServer({
  configFile: false, root, publicDir: resolve(web, "public"),
  cacheDir: resolve(root, ".vite"),
  plugins: [{
    name: "disposable-harness-api-only",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/")) return next();
        response.setHeader("Content-Type", "application/json");
        const data = request.url === "/api/session/admin-mode"
          ? { active: true, eligible: true, canReturn: true, expiresAt: new Date(Date.now() + 900000).toISOString() }
          : request.url === "/api/proxy/platform/ai" ? ai : { count: 0 };
        response.end(JSON.stringify(data));
      });
    },
  }],
  resolve: {
    alias: [
      ...aliases.map((find) => ({ find, replacement: mock })),
      { find: "@", replacement: web },
      { find: /^react$/, replacement: requireWeb.resolve("react") },
      { find: /^react\/jsx-runtime$/, replacement: requireWeb.resolve("react/jsx-runtime") },
      { find: /^react\/jsx-dev-runtime$/, replacement: requireWeb.resolve("react/jsx-dev-runtime") },
      { find: /^react-dom\/client$/, replacement: requireWeb.resolve("react-dom/client") },
    ],
  },
  esbuild: { jsx: "automatic" },
  css: { postcss: { plugins: [
    requireWeb("tailwindcss")({ ...tailwindConfig, content: [resolve(web, "app/**/*.{ts,tsx}"), resolve(web, "components/**/*.{ts,tsx}")] }),
    requireWeb("autoprefixer")(),
  ] } },
  server: { host: "127.0.0.1", port: 4178, strictPort: true, fs: { allow: [web, root, resolve(web, "../..")] } },
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(existsSync("/repl/tools/bin/chromium") ? { executablePath: "/repl/tools/bin/chromium" } : {}),
});
const failures: string[] = [];
const results: unknown[] = [];
try {
  const context = await browser.newContext();
  // No request can reach a protected real API or external service.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (url.pathname === "/api/session/admin-mode") return route.fulfill({ json: { active: true, eligible: true, canReturn: true, expiresAt: new Date(Date.now() + 900000).toISOString() } });
    if (url.pathname === "/api/proxy/platform/ai") return route.fulfill({ json: ai });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { count: 0 } });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => { failures.push(error.message); console.error("Harness browser:", error.message); });
  page.on("console", (message) => { if (message.type() === "error") console.error("Harness console:", message.text()); });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [320, 390, 430, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      for (const path of ["/platform", "/platform/ai", "/platform?loading", "/platform?error"]) {
        await page.goto(`http://127.0.0.1:4178${path}`);
        await page.getByText("Mode super-admin actif", { exact: true }).waitFor();
        if (path === "/platform/ai") await page.locator('input[type="password"]').first().waitFor();
        const layout = await page.evaluate(() => {
          const cards = [...document.querySelectorAll(".platform-stat")].map((node) => node.getBoundingClientRect().toJSON());
          const header = document.querySelector("header")!.getBoundingClientRect().toJSON();
          return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, header, cards,
            background: getComputedStyle(document.querySelector(".app-shell")!).backgroundColor,
            cardBackground: cards.length ? getComputedStyle(document.querySelector(".platform-stat")!).backgroundColor : null };
        });
        assert(layout.documentWidth <= width, `${theme} ${width} ${path}: horizontal overflow ${layout.documentWidth}`);
        assert(layout.header.right <= width, "Header overflow");
        if (path === "/platform") {
          assert(layout.cards[0].y === layout.cards[1].y, "Metrics must share first row");
          if (width < 768) assert(layout.cards[0].width < width / 2, "Metrics must be compact");
          if (theme === "dark") assert.equal(layout.cardBackground, "rgb(20, 42, 48)");
        }
        assert.equal(await page.locator(".company-switcher").count(), 0);
        const nav = page.getByRole("navigation", { name: width < 768 ? "Navigation mobile plateforme" : "Administration plateforme", exact: true });
        assert.equal(await nav.locator('a[href="/entries"]').count(), 0);
        assert.equal(await nav.locator('a[href="/platform#organizations"]').count(), 1);
        const file = `${theme}-${width}-${path.includes("/ai") ? "ai" : path.includes("loading") ? "loading" : path.includes("error") ? "error" : "overview"}.png`;
        await page.screenshot({ path: resolve(shots, file), fullPage: true });
        results.push({ theme, width, path, ...layout, screenshot: file });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:4178/platform");
  await page.getByText("Mode super-admin actif", { exact: true }).waitFor();
  const search = page.getByRole("textbox", { name: "Rechercher une organisation ou un dossier" });
  await search.fill("aucun-resultat-attendu");
  await page.getByRole("heading", { name: "Aucun résultat", exact: true }).waitFor();
  await page.getByRole("button", { name: "Effacer la recherche" }).click();
  await page.getByRole("heading", { name: "Cabinet Ndiaye & Associés" }).waitFor();
  await page.locator("summary").filter({ hasText: /^Compte$/ }).click();
  assert(await page.getByRole("link", { name: "Sécurité · double authentification" }).isVisible());
  assert(await page.getByRole("button", { name: "Se déconnecter", exact: true }).isVisible());
  await page.screenshot({ path: resolve(shots, "dark-390-account-open.png") });
  await page.locator("summary").filter({ hasText: /^Compte$/ }).click();
  await page.locator('nav[aria-label="Navigation mobile plateforme"] a[href="/platform#organizations"]').click();
  await page.waitForURL("**/platform#organizations");
  assert(await page.evaluate(() => scrollY > 0), "Organization anchor must scroll");
  const selected = page.waitForRequest((request) => request.url().endsWith("/api/session/tenant") && request.method() === "POST");
  await page.getByRole("button", { name: "Ouvrir", exact: true }).click();
  assert.deepEqual((await selected).postDataJSON(), { tenantId: overview.organizations[0].companies[0].id });
  await page.waitForURL("**/dashboard");
  await page.locator(".company-switcher").waitFor();
  assert.equal(await page.locator('nav[aria-label="Navigation mobile"] a[href="/entries"]').count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Company workspace header must fit");
  assert.deepEqual(failures, [], "Browser errors");
  await writeFile(resolve(root, "results.json"), JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} responsive route/theme captures; search/reset, account controls, organization anchor, tenant selection and restored customer navigation; no browser errors.\nHarness: http://127.0.0.1:4178/platform\nEvidence: ${root}`);
} finally {
  await browser.close();
  if (!process.argv.includes("--serve")) await server.close();
}
if (process.argv.includes("--serve")) {
  // Keep the disposable process inspectable; no application workflow is touched.
  await new Promise(() => { setInterval(() => {}, 60_000); });
}
