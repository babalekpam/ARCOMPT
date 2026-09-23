// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money } from "@arcompt/ledger";
import type { Amount, Locale } from "./views.js";

/**
 * Mise en forme des nombres, des montants, des taux et des dates, langue par
 * langue.
 *
 * Traduire les libellés ne suffit pas : un état anglais où les montants
 * s'écrivent « 1 234,50 » et les dates « 31/12/2025 » reste illisible pour
 * celui qui le reçoit. Tout ce qui diffère d'une langue à l'autre est donc
 * décidé ici, en un seul endroit :
 *
 *   ┌────────────────────┬──────────────────────┬──────────────────────┐
 *   │                    │ fr                   │ en                   │
 *   ├────────────────────┼──────────────────────┼──────────────────────┤
 *   │ milliers           │ espace insécable     │ virgule              │
 *   │ décimale           │ virgule              │ point                │
 *   │ devise             │ 1 234,50 XOF         │ XOF 1,234.50         │
 *   │ pourcentage        │ 18 % (espace ins.)   │ 18%                  │
 *   │ date               │ 31/12/2025           │ 31 Dec 2025          │
 *   │ deux-points        │ « Total : 12 »       │ « Total: 12 »        │
 *   │ sens du solde      │ D / C                │ Dr / Cr              │
 *   └────────────────────┴──────────────────────┴──────────────────────┘
 *
 * Le nombre de décimales, lui, ne dépend pas de la langue mais de la devise :
 * il vient de `Money.format` (XOF et XAF n'en ont aucune, EUR et USD deux).
 * On ne reprend donc de `Money.format` que la ponctuation, jamais les chiffres.
 *
 * Le séparateur de milliers français est une espace INSÉCABLE (U+00A0) : une
 * espace ordinaire laisserait « 1 234 » se couper en fin de ligne dans un PDF.
 */

interface Punctuation {
  group: string;
  decimal: string;
}

const PUNCTUATION: Record<Locale, Punctuation> = {
  fr: { group: " ", decimal: "," },
  en: { group: ",", decimal: "." },
};

/** Espace insécable : sépare un nombre de son unité sans jamais la rejeter à la ligne. */
export const NBSP = " ";

export function money(a: Amount): Money {
  return Money.parse(a);
}

export interface FmtOptions {
  /** Affichage du zéro : tiret (états officiels) ou « 0 ». */
  zero?: "dash" | "zero";
  /** Négatifs : signe moins typographique « − » ou parenthèses. */
  negative?: "minus" | "parentheses";
}

/**
 * Re-ponctue le rendu de `Money.format` selon la langue. `Money.format` sort
 * « 1 234.50 » (espace + point) : un hybride qui n'est correct dans aucune des
 * deux langues. On garde ses chiffres — donc les décimales de la devise — et
 * on remplace ses séparateurs.
 */
function punctuate(formatted: string, locale: Locale): string {
  const p = PUNCTUATION[locale];
  const dot = formatted.lastIndexOf(".");
  const whole = (dot === -1 ? formatted : formatted.slice(0, dot)).replace(/ /g, p.group);
  return dot === -1 ? whole : `${whole}${p.decimal}${formatted.slice(dot + 1)}`;
}

/** Montant nu, sans code devise : « 1 234,50 » (fr) ou « 1,234.50 » (en). */
export function formatAmount(a: Amount | undefined, currency: string, locale: Locale, opts: FmtOptions = {}): string {
  if (a === undefined) return "";
  const m = money(a);
  if (m.isZero()) return opts.zero === "zero" ? punctuate(Money.zero().format(currency), locale) : "–";
  const abs = punctuate(m.abs().format(currency), locale);
  if (!m.isNegative()) return abs;
  return opts.negative === "parentheses" ? `(${abs})` : `−${abs}`;
}

/**
 * Montant suivi (fr) ou précédé (en) de son code ISO : « 1 234,50 XOF » contre
 * « XOF 1,234.50 ». L'usage anglophone des affaires place le code avant le
 * nombre ; l'usage français le place après. Le code n'est jamais séparable du
 * montant : espace insécable des deux côtés.
 */
export function formatMoney(a: Amount | undefined, currency: string, locale: Locale, opts: FmtOptions = {}): string {
  const amount = formatAmount(a, currency, locale, opts);
  if (amount === "") return "";
  return locale === "en" ? `${currency}${NBSP}${amount}` : `${amount}${NBSP}${currency}`;
}

/** Solde avec son sens : « 1 234 D » / « 1 234 C » (fr), « 1,234 Dr » / « 1,234 Cr » (en). */
export function formatSide(a: Amount, currency: string, locale: Locale): string {
  const m = money(a);
  if (m.isZero()) return "–";
  const side = m.isNegative() ? (locale === "en" ? "Cr" : "C") : locale === "en" ? "Dr" : "D";
  return `${formatAmount(m.abs(), currency, locale, { zero: "zero" })}${NBSP}${side}`;
}

/**
 * Pourcentage : « 18 % » en français (espace insécable avant le signe, règle
 * typographique française), « 18% » en anglais (aucune espace).
 *
 * Le texte vient souvent d'un module amont déjà mis en forme (« 6,3 % » du
 * calcul de paie). On ne le réécrit que s'il est bien un nombre : sinon il
 * ressort inchangé, un taux libre (« 1/3 », « forfait ») ne devant pas être
 * abîmé.
 */
export function formatRateText(text: string | undefined, locale: Locale): string {
  if (text === undefined || text.trim() === "") return "";
  const m = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(%?)\s*$/.exec(text);
  if (!m) return text;
  const p = PUNCTUATION[locale];
  const number = m[1]!.replace(/[.,]/, p.decimal);
  if (m[2] !== "%") return number;
  return locale === "en" ? `${number}%` : `${number}${NBSP}%`;
}

/** Taux exprimé en pourcentage à partir d'un nombre nu (« 18 » → « 18 % » / « 18% »). */
export function formatPercent(value: string | number, locale: Locale): string {
  return formatRateText(`${value} %`, locale);
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Date ISO → « 31/12/2025 » (fr) ou « 31 Dec 2025 » (en).
 *
 * L'anglais évite délibérément « 31/12/2025 » et « 12/31/2025 » : les deux
 * existent selon le pays et rien ne les distingue à la lecture. Le mois écrit
 * en lettres lève l'ambiguïté pour un lecteur de n'importe quel pays, ce qui
 * est la moindre des choses sur une facture ou une mise en demeure.
 * Toute chaîne qui n'est pas une date ISO ressort telle quelle.
 */
export function formatDate(iso: string | undefined | null, locale: Locale): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (locale === "en") {
    const month = EN_MONTHS[Number(mo) - 1];
    return month ? `${Number(d)} ${month} ${y}` : `${y}-${mo}-${d}`;
  }
  return `${d}/${mo}/${y}`;
}

/** Horodatage ISO → « 31/12/2025 à 14:05 UTC » (fr) ou « 31 Dec 2025, 14:05 UTC » (en). */
export function formatDateTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = formatDate(d.toISOString(), locale);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return locale === "en" ? `${date}, ${hh}:${mm} UTC` : `${date} à ${hh}:${mm} UTC`;
}

/**
 * Deux-points : le français en fait un signe à espace insécable avant
 * (« Total : 12 »), l'anglais le colle au mot (« Total: 12 »). Une facture
 * anglaise qui écrit « Total : 12 » se lit comme une traduction.
 */
export function colon(locale: Locale): string {
  return locale === "en" ? ": " : `${NBSP}: `;
}

/** « Libellé : valeur » correctement espacé dans la langue. */
export function labelled(locale: Locale, label: string, value: string): string {
  return `${label}${colon(locale)}${value}`;
}

/**
 * Tiret d'énumération entre deux fragments (« Note 3 – Immobilisations »).
 * Identique dans les deux langues, isolé ici pour rester unique.
 */
export const DASH = " – ";
