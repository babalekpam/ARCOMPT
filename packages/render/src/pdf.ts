import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

/**
 * Conversion HTML → PDF par Chromium (playwright-core, sans téléchargement de
 * navigateur). Une seule instance de navigateur est ouverte paresseusement et
 * partagée ; chaque rendu utilise un contexte isolé.
 */

export const DEFAULT_CHROMIUM_PATH = "/opt/pw-browsers/chromium";

export interface PdfOptions {
  /** Force le paysage pour tout le document (sinon la CSS @page décide, page par page). */
  landscape?: boolean;
  format?: "A4" | "Letter";
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /** Pied de page « Page x / y » (défaut : oui). */
  pageNumbers?: boolean;
  timeoutMs?: number;
}

/**
 * Chemin du binaire Chromium : CHROMIUM_PATH, puis le chemin par défaut de
 * l'image, puis le navigateur enregistré par Playwright ; sinon erreur claire.
 */
export function resolveChromiumPath(): string {
  const candidates: string[] = [];
  const configured = process.env.CHROMIUM_PATH ?? DEFAULT_CHROMIUM_PATH;
  candidates.push(configured);
  if (existsSync(configured)) return configured;
  try {
    const fromPlaywright = chromium.executablePath();
    candidates.push(fromPlaywright);
    if (fromPlaywright && existsSync(fromPlaywright)) return fromPlaywright;
  } catch {
    // Playwright ne connaît aucun navigateur : on tombe sur l'erreur ci-dessous.
  }
  throw new Error(
    `Chromium introuvable (essayé : ${candidates.join(", ")}). Définissez CHROMIUM_PATH vers un binaire Chromium ou installez le navigateur Playwright.`,
  );
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        executablePath: resolveChromiumPath(),
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
      })
      .then((b) => {
        b.on("disconnected", () => {
          browserPromise = null;
        });
        return b;
      })
      .catch((err: unknown) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/** Rend un document HTML (tel que produit par `renderHtml`) en PDF. */
export async function renderPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs ?? 30_000);
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    const pageNumbers = opts.pageNumbers ?? true;
    const pdf = await page.pdf({
      format: opts.format ?? "A4",
      printBackground: true,
      // Sans orientation imposée, la CSS @page (portrait/paysage par section) fait foi.
      preferCSSPageSize: opts.landscape === undefined,
      ...(opts.landscape !== undefined ? { landscape: opts.landscape } : {}),
      margin: opts.margin ?? { top: "12mm", right: "11mm", bottom: "14mm", left: "11mm" },
      displayHeaderFooter: pageNumbers,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="font-family:Helvetica,Arial,sans-serif;font-size:7pt;color:#666;width:100%;text-align:center;">Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return Buffer.from(pdf);
  } finally {
    await context.close();
  }
}

/** Ferme le navigateur partagé (arrêt du serveur, fin des tests). */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) {
    const browser = await pending.catch(() => null);
    await browser?.close();
  }
}
