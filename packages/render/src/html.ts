import { t, type LabelKey } from "./i18n.js";
import { DEFAULT_LOCALE } from "./locale.js";
import {
  DASH,
  NBSP,
  colon,
  formatAmount,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatRateText,
  formatSide,
  labelled,
  money,
  type FmtOptions,
} from "./format.js";
import type { Amount, CompanyHeader, Locale, RenderOptions } from "./views.js";

/**
 * Briques communes des gabarits HTML : échappement, en-tête d'entreprise,
 * squelette de document et feuille de style d'impression A4.
 *
 * La mise en forme des nombres et des dates vit dans `format.ts` ; elle est
 * exposée ici par le contexte de rendu (`Ctx`), pour qu'un gabarit n'ait
 * jamais à savoir dans quelle langue il travaille.
 */

export { DASH, NBSP, colon, formatAmount, formatDate, formatDateTime, formatMoney, formatPercent, formatRateText, formatSide, labelled, money, type FmtOptions };

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/**
 * Contexte de rendu d'un document : sa langue, sa devise, et tous les
 * raccourcis de mise en forme déjà liés à l'une et à l'autre. Un gabarit
 * écrit `ctx.n(montant)` et `ctx.d(date)` sans jamais tester la langue :
 * c'est ce qui empêche un « 31/12/2025 » de réapparaître dans un document
 * anglais au détour d'une ligne oubliée.
 */
export interface Ctx {
  locale: Locale;
  currency: string;
  company: CompanyHeader | undefined;
  generatedAt: string;
  watermark: string | undefined;
  /** Libellé traduit. */
  L: (key: LabelKey) => string;
  /** Montant nu : « 1 234,50 » / « 1,234.50 ». */
  n: (a: Amount | undefined, opts?: FmtOptions) => string;
  /** Montant et code devise : « 1 234,50 XOF » / « XOF 1,234.50 ». */
  m: (a: Amount | undefined, opts?: FmtOptions) => string;
  /** Date ISO : « 31/12/2025 » / « 31 Dec 2025 ». */
  d: (iso: string | undefined | null) => string;
  /** Horodatage ISO, fuseau dit. */
  dt: (iso: string) => string;
  /** Solde avec son sens : « 1 234 D » / « 1,234 Dr ». */
  dc: (a: Amount) => string;
  /** Taux fourni par un module amont, re-ponctué (« 6,3 % » / « 6.3% »). */
  rate: (text: string | undefined) => string;
  /** Pourcentage à partir d'un nombre nu (« 18 » → « 18 % » / « 18% »). */
  pct: (value: string | number) => string;
  /** « Libellé : valeur », espacé selon la langue. */
  kv: (label: string, value: string) => string;
  /** Deux-points espacé selon la langue. */
  colon: string;
}

export function makeCtx(opts: RenderOptions, currency: string): Ctx {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return {
    locale,
    currency,
    company: opts.company,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    watermark: opts.watermark,
    L: (key) => t(locale, key),
    n: (a, o = {}) => formatAmount(a, currency, locale, o),
    m: (a, o = {}) => formatMoney(a, currency, locale, o),
    d: (iso) => formatDate(iso, locale),
    dt: (iso) => formatDateTime(iso, locale),
    dc: (a) => formatSide(a, currency, locale),
    rate: (text) => formatRateText(text, locale),
    pct: (value) => formatPercent(value, locale),
    kv: (label, value) => labelled(locale, label, value),
    colon: colon(locale),
  };
}

/** Cellule numérique alignée à droite, classe `neg` pour les négatifs. */
export function td(ctx: Ctx, a: Amount | undefined, opts: FmtOptions = {}, extraClass = ""): string {
  const neg = a !== undefined && money(a).isNegative();
  return `<td class="num${neg ? " neg" : ""}${extraClass ? " " + extraClass : ""}">${ctx.n(a, opts)}</td>`;
}

/** Bloc d'identification de l'entreprise (nom, forme, identifiants, adresse). */
export function companyBlock(company: CompanyHeader | undefined, ctx: Ctx, tagClass = "company"): string {
  if (!company) return `<div class="${tagClass}"><div class="company-name">—</div></div>`;
  const capitalCurrency = company.capitalCurrency ?? ctx.currency;
  const capital = company.capital !== undefined ? `${ctx.L("capital")} ${formatMoney(company.capital, capitalCurrency, ctx.locale, { zero: "zero" })}` : "";
  const legal = [company.legalForm, capital].filter(Boolean).join(" · ");
  const ids = (company.identifiers ?? []).map((i) => `<span class="id"><b>${esc(i.label)}</b> ${esc(i.value)}</span>`).join(" · ");
  const address = [company.address, [company.city, company.country].filter(Boolean).join(", ")].filter(Boolean).join("<br>");
  const contact = [company.phone, company.email].filter(Boolean).map(esc).join(" · ");
  return `<div class="${tagClass}">
    ${company.logoDataUri ? `<img class="logo" src="${esc(company.logoDataUri)}" alt="">` : ""}
    <div class="company-name">${esc(company.name)}</div>
    ${legal ? `<div class="small">${esc(legal)}</div>` : ""}
    ${ids ? `<div class="small ids">${ids}</div>` : ""}
    ${address ? `<div class="small">${address}</div>` : ""}
    ${contact ? `<div class="small">${contact}</div>` : ""}
  </div>`;
}

/** En-tête répété en haut de chaque page (section `.page`). */
export function pageHeader(ctx: Ctx, title: string, meta: string[]): string {
  return `<header class="doc-header">
    ${companyBlock(ctx.company, ctx)}
    <div class="meta">
      <div class="doc-title">${esc(title)}</div>
      ${meta.map((m) => `<div>${m}</div>`).join("")}
    </div>
  </header>`;
}

/**
 * Marque ARCOMPT en data URI (aucun réseau : ces gabarits sont rendus par un
 * Chromium isolé, sans accès sortant). Le logo fourni est matriciel : il ne
 * peut plus hériter du gris `currentColor` du pied de page et porte donc ses
 * trois couleurs, ce qui reste discret à 7 pt.
 *
 * PNG 64 x 64, palette 16 couleurs, 868 octets. Affiche a 7 pt (~2,47 mm),
 * soit environ 660 ppp : net au tirage. Genere depuis
 * `apps/web/public/brand/arcompt-mark-512.png` ; toute retouche vaut pour les
 * deux. Voir `docs/BRAND.md`, section « Lisibilite en petit » : sur un ecran a
 * 100 % la marque se reduit a un galet colore, elle ne reprend corps qu au
 * tirage.
 */
const MARK_PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABABAMAAABYR2ztAAAAMFBMVEVIdXcVM08bsJ01ZGstZ3Erpp8jkZcYMUsiNk0YeZUZMUsdM0sLd5X8/f59tMTB2+F1uP39AAAADHRSTlMC/v4XPOqT22nkwptoivP6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAACwklEQVRIx5WWQWsTQRTHB3axaTwNLWxJbgu5DzY1xV4mNmDAW7GePCymFoQeDBEEvSRYUNqL0FAoVGhAaKgXg0JDcxQDC9v4CVpPHgTJJ2jQ92Z2NzOTJqFzSAjvt//3f+/tzISQmy67sDgZmA38/dXJAKx9NgUIunwKMIEIgaDLpgBBfRoQVMcB63IF3higdyHXE+96n7M/Y2ATG2uEbzEF2AKJZQN4pips7RHy0BDIaECXkLYOPNWBgFsvdQEXgB99uQIAPiTmdAEE4kYB8H3mSBdwH+mAV6saAhwa9evyfHA1+HeIHsrcFECTl+cXVwNRRSI1IqABe7kFU+Aug1nEgNeaNwXWVZPPbXpkCCxBmb3+717/b79/6G0kadUQWMuoHljNMQVcCXyUgE0XdAFrTQdytKILwIeYxR/hwWctsMBVB0vucBYHB/UEhTZ9VZsoAWmSW7xG54ldUZuoAcSm9AsJxy0EVpgO5KnDSHJuWMKrUEG2moMAFJmvxAL3HNWkz/OYgbQqsUBDA6AErMEqv4gFqAr4rEaxSwkxrfuuCwIa4N2mlEJdOUxju67LklQF6sBTfBWwl5jBALrsHQhAyBYyI4DPMQEOMomtGAH8kl2GXzilGk3LIjIqULJaIIBbTvbKBLIEDaTwCMuJUiUwEwMiLt/FhmimBHII3HEzJbJDwwQk7IUKPOaWeD4tzkiwkiYakCX2KcZTPBKIZpkBP04TDqQGxh1hAJsprQhgpQ2vkEgfxskDKuaJ1W5uFPBrtyziKRlP0CiDWNn3Z1SuN/I9F82SGYqdzslxGKXOt/CMF8XIfRVJY7gdbRMRj3euVQSN1yed7eiGkM1QN6Zx751STUCuYqRuRSk/GY8dN7dXF7PF3UZoaCRBIvZKh+PQNRpq/LrLxNqJ480xV97yGeZxPr8df+9ahUKB3ezfwH9bG4ug46DwMwAAAABJRU5ErkJggg==";

const MARK_IMG = `<img class="mark" alt="" src="${MARK_PNG_DATA_URI}">`;

/**
 * Pied de page : date d'édition puis la mention du logiciel producteur.
 * La marque ARCOMPT y désigne l'outil qui a produit le document — jamais
 * l'entreprise cliente, dont l'identité reste dans l'en-tête.
 */
export function pageFooter(ctx: Ctx): string {
  return `<footer class="doc-footer">${esc(ctx.L("generatedOn"))} ${esc(ctx.dt(ctx.generatedAt))} · <span class="producer">${MARK_IMG}ARCOMPT</span></footer>`;
}

/** Document HTML complet : squelette, style d'impression, filigrane éventuel. */
export function layout(ctx: Ctx, title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="${ctx.locale}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${ctx.watermark ? `<div class="watermark">${esc(ctx.watermark)}</div>` : ""}
${body}
</body>
</html>`;
}

export const CSS = `
@page { size: A4 portrait; margin: 12mm 11mm 14mm 11mm; }
@page landscape { size: A4 landscape; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; font-size: 9pt; color: #111; line-height: 1.3; }
.page { page-break-after: always; break-after: page; position: relative; }
.page:last-of-type { page-break-after: auto; break-after: auto; }
.page.landscape { page: landscape; }
.doc-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a3a5c; padding-bottom: 6px; margin-bottom: 10px; gap: 12px; }
.company-name { font-weight: 700; font-size: 12pt; color: #1a3a5c; }
.logo { max-height: 42px; max-width: 120px; display: block; margin-bottom: 4px; }
.meta { text-align: right; font-size: 8.5pt; color: #333; min-width: 40%; }
.doc-title { font-weight: 700; font-size: 11pt; color: #1a3a5c; text-transform: uppercase; letter-spacing: .04em; }
.doc-footer { margin-top: 10px; padding-top: 4px; border-top: 1px solid #bbb; font-size: 7.5pt; color: #666; text-align: right; }
.doc-footer .producer { white-space: nowrap; }
.doc-footer .producer .mark { width: 7pt; height: 7pt; vertical-align: -0.8pt; margin-right: 1.5pt; display: inline-block; }
h1 { font-size: 14pt; text-transform: uppercase; margin: 6px 0 4px; color: #1a3a5c; letter-spacing: .04em; }
h2 { font-size: 11pt; margin: 12px 0 4px; color: #1a3a5c; }
h3 { font-size: 10pt; margin: 10px 0 3px; }
.small { font-size: 8pt; color: #444; }
.ids .id { margin-right: 4px; }
.muted { color: #666; }
/* Glose anglaise d'un intitulé réglementaire : présente mais visiblement seconde. */
.gloss { color: #556; font-style: italic; font-size: 8pt; }
table.fin tr.total .gloss, table.fin tr.subtotal .gloss, table.fin tr.grand .gloss { font-weight: 400; }
.official { margin: 0 0 6px; }
table.fin { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
table.fin th, table.fin td { border: 1px solid #8a8a8a; padding: 2.5px 5px; vertical-align: top; }
table.fin th { background: #e8eef5; font-weight: 600; text-align: center; font-size: 8.5pt; }
table.fin td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.fin td.neg { color: #7a0000; }
table.fin td.code { width: 3em; text-align: center; font-family: "DejaVu Sans Mono", Menlo, monospace; font-size: 8pt; color: #333; }
table.fin td.note { width: 3.2em; text-align: center; color: #555; font-size: 8pt; }
table.fin tr.subtotal td { font-weight: 600; background: #f3f6fa; }
table.fin tr.total td { font-weight: 700; background: #dde6f0; border-top: 2px solid #1a3a5c; }
table.fin tr.header td { font-weight: 700; text-transform: uppercase; background: #fafafa; }
table.fin tr.grand td { font-weight: 700; background: #c9d7e6; }
table.kv { border-collapse: collapse; }
table.kv td { padding: 1px 6px 1px 0; vertical-align: top; }
table.kv td.k { color: #555; white-space: nowrap; }
.box { border: 1px solid #8a8a8a; padding: 6px 8px; border-radius: 2px; }
.row { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
.col { flex: 1; }
.banner { border: 2px dashed #b00020; color: #b00020; font-weight: 700; padding: 5px 8px; text-align: center; text-transform: uppercase; margin: 6px 0; letter-spacing: .06em; }
.ok { color: #157347; font-weight: 700; }
.ko { color: #b00020; font-weight: 700; }
.badge { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 8pt; font-weight: 700; }
.badge.ok { background: #d9f2e3; color: #0f5132; }
.badge.ko { background: #f8d7da; color: #842029; }
.badge.blocking { background: #ffe5b4; color: #7a4100; }
.badge.warning { background: #e2e3e5; color: #41464b; }
section.note { break-inside: avoid; margin-bottom: 12px; }
section.account { break-inside: avoid-page; margin-bottom: 10px; }
.watermark { position: fixed; top: 40%; left: 10%; right: 10%; text-align: center; font-size: 64pt; color: rgba(160, 0, 0, .12); transform: rotate(-24deg); font-weight: 800; letter-spacing: .1em; pointer-events: none; z-index: 0; }
.total-box { border: 2px solid #1a3a5c; padding: 6px 10px; font-size: 11pt; font-weight: 700; background: #dde6f0; text-align: right; }
.qr { width: 88px; height: 88px; border: 1px solid #444; display: flex; align-items: center; justify-content: center; font-size: 8pt; color: #666; text-align: center; padding: 4px; word-break: break-all; }
.qr img { width: 100%; height: 100%; }
ul.legal { font-size: 7.5pt; color: #444; padding-left: 14px; margin: 4px 0; }
ol.outline { margin: 4px 0 4px 18px; }
.right { text-align: right; }
.center { text-align: center; }
`;
