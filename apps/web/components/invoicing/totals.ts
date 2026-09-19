/**
 * Aperçu des totaux HT / TVA / TTC côté navigateur, sans flottant.
 *
 * Reprend la règle du serveur (paquet posting, arrondi « par ligne ») :
 *   HT ligne  = prix unitaire × quantité, arrondi aux décimales de la devise ;
 *   TVA ligne = HT × taux (taux à 10 décimales), arrondi aux décimales de la devise ;
 *   TTC ligne = HT + TVA.
 * Les codes TVA sont ceux du pack pays (GET /v1/packs/:code → vat.rates),
 * sélectionnés par code et par date de validité.
 */
import { CURRENCY_DECIMALS, fromMinor, SCALE, toMinor } from "../../lib/money";
import type { PackVatRate } from "./types";

const FACTOR = 10n ** BigInt(SCALE);
const RATE_SCALE = 10;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

/** Division entière arrondie au plus proche (demi vers l'infini), comme dans le ledger. */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (b < 0n ? -b : b)) return (a < 0n) !== (b < 0n) ? q - 1n : q + 1n;
  return q;
}

/** Taux décimal ("0.18", "2.5", 18) → entier à 10 décimales. */
export function parseRate(rate: string | number): bigint {
  const text = String(rate).trim().replace(",", ".");
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`Taux invalide : "${rate}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  const frac = ((m[3] ?? "") + "0".repeat(RATE_SCALE)).slice(0, RATE_SCALE);
  return sign * (BigInt(m[2] ?? "0") * RATE_FACTOR + BigInt(frac));
}

/** Multiplie un montant (unités mineures) par un taux décimal, arrondi au plus proche. */
export function mulRateMinor(minor: bigint, rate: string | number): bigint {
  return divRound(minor * parseRate(rate), RATE_FACTOR);
}

/** Arrondit un montant (unités mineures) aux décimales de la devise. */
export function roundMinor(minor: bigint, decimals: number): bigint {
  if (decimals >= SCALE) return minor;
  const step = 10n ** BigInt(SCALE - decimals);
  return divRound(minor, step) * step;
}

export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency] ?? 2;
}

/** Taux du pack valable à la date donnée pour un code ; null si le code est inconnu. */
export function findVatRate(rates: PackVatRate[], code: string | null | undefined, date: string): PackVatRate | null {
  if (!code) return null;
  return rates.find((r) => r.code === code && (r.valid_from === undefined || r.valid_from <= date) && (r.valid_to === undefined || date <= r.valid_to)) ?? null;
}

export interface PreviewLineInput {
  /** Quantité (chaîne décimale) ; défaut "1". Ignorée si `net` est fourni. */
  quantity?: string;
  /** Prix unitaire HT (chaîne décimale). Ignoré si `net` est fourni. */
  unitPrice?: string;
  /** Montant HT saisi directement (achats). */
  net?: string;
  vatCode?: string | null;
}

export interface PreviewLine {
  net: string;
  vatRate: string;
  vat: string;
  gross: string;
  /** Code TVA fourni mais inconnu du pack à cette date : le serveur refusera. */
  unknownVatCode: boolean;
}

export interface Preview {
  lines: PreviewLine[];
  totalNet: string;
  totalVat: string;
  totalGross: string;
  /** Récapitulatif par code TVA, dans l'ordre d'apparition. */
  byVatCode: Array<{ vatCode: string; rate: string; base: string; vat: string }>;
  valid: boolean;
}

function parseOrZero(v: string | undefined): bigint | null {
  if (v === undefined || v.trim() === "") return 0n;
  try {
    return toMinor(v);
  } catch {
    return null;
  }
}

/**
 * Calcule l'aperçu des totaux. Une saisie illisible rend la ligne à zéro et
 * marque l'aperçu `valid: false` ; le formulaire bloque alors l'envoi.
 */
export function previewTotals(lines: PreviewLineInput[], opts: { rates: PackVatRate[]; currency: string; date: string }): Preview {
  const decimals = currencyDecimals(opts.currency);
  let valid = true;
  const byCode = new Map<string, { vatCode: string; rate: string; base: bigint; vat: bigint }>();
  let totalNet = 0n;
  let totalVat = 0n;
  const out: PreviewLine[] = lines.map((l) => {
    let net: bigint;
    if (l.net !== undefined) {
      const n = parseOrZero(l.net);
      if (n === null) valid = false;
      net = roundMinor(n ?? 0n, decimals);
    } else {
      const price = parseOrZero(l.unitPrice);
      const qty = l.quantity === undefined || l.quantity.trim() === "" ? "1" : l.quantity.trim().replace(",", ".");
      if (price === null || !/^\d+(\.\d{1,4})?$/.test(qty)) {
        valid = false;
        net = 0n;
      } else net = roundMinor(mulRateMinor(price, qty), decimals);
    }
    const rate = findVatRate(opts.rates, l.vatCode, opts.date);
    const unknownVatCode = Boolean(l.vatCode) && rate === null;
    if (unknownVatCode) valid = false;
    const rateText = rate ? String(rate.rate) : "0";
    const vat = rate ? roundMinor(mulRateMinor(net, rateText), decimals) : 0n;
    totalNet += net;
    totalVat += vat;
    if (rate && l.vatCode) {
      const row = byCode.get(l.vatCode) ?? { vatCode: l.vatCode, rate: rateText, base: 0n, vat: 0n };
      row.base += net;
      row.vat += vat;
      byCode.set(l.vatCode, row);
    }
    return { net: fromMinor(net), vatRate: rateText, vat: fromMinor(vat), gross: fromMinor(net + vat), unknownVatCode };
  });
  return {
    lines: out,
    totalNet: fromMinor(totalNet),
    totalVat: fromMinor(totalVat),
    totalGross: fromMinor(totalNet + totalVat),
    byVatCode: [...byCode.values()].map((r) => ({ vatCode: r.vatCode, rate: r.rate, base: fromMinor(r.base), vat: fromMinor(r.vat) })),
    valid,
  };
}

/** Somme d'affectations (chaînes) ; les saisies vides comptent zéro, les illisibles rendent null. */
export function sumAllocations(amounts: string[]): string | null {
  let acc = 0n;
  for (const a of amounts) {
    if (a.trim() === "") continue;
    try {
      acc += toMinor(a);
    } catch {
      return null;
    }
  }
  return fromMinor(acc);
}

/** Convertit une chaîne canonique en unités mineures (exposé pour les tests). */
export const minorOf = (s: string): bigint => toMinor(s);
export const MINOR_FACTOR = FACTOR;
