// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { DEFAULT_LOCALE } from "./locale.js";
import type { Locale } from "./views.js";

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
  /**
   * Langue du pied de page de pagination. Il est écrit par Chromium, hors du
   * HTML : c'est le seul texte du PDF que les gabarits ne voient pas passer,
   * et le seul qui resterait en français si on l'oubliait.
   */
  locale?: Locale;
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

/**
 * Pagination : « Page 3 / 12 » en français, « Page 3 of 12 » en anglais. Le
 * « / » français est la forme d'usage sur les états comptables ; l'anglais
 * écrit « of », et « Page 3 / 12 » y passerait pour une coquille.
 */
function pageFooterTemplate(locale: Locale): string {
  const separator = locale === "en" ? "of" : "/";
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:7pt;color:#666;width:100%;text-align:center;">Page <span class="pageNumber"></span> ${separator} <span class="totalPages"></span></div>`;
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
      footerTemplate: pageFooterTemplate(opts.locale ?? DEFAULT_LOCALE),
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
