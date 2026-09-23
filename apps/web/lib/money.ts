/**
 * Formatage et arithmétique de montants sous forme de chaînes décimales.
 *
 * L'API renvoie les montants en chaînes canoniques à 4 décimales ("1234.5000",
 * NUMERIC(20,4)). Ce module reprend la logique de Money.format du paquet ledger
 * sans l'importer : il tourne côté navigateur et ne manipule jamais de flottant.
 *
 * La PONCTUATION suit la langue de l'interface, pas la devise : « 1 234,50 »
 * en français, « 1,234.50 » en anglais. Le nombre de décimales, lui, suit la
 * devise (le franc CFA n'a pas de centime). Les deux se décident ici, et
 * `components/ui/Money.tsx` est le seul à les appliquer dans l'interface.
 */
import { DEFAULT_LOCALE, type Locale } from "./i18n";
export const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

/** Nombre de décimales d'affichage par devise (défaut : 2). */
export const CURRENCY_DECIMALS: Record<string, number> = {
  XOF: 0,
  XAF: 0,
  GNF: 0,
  CDF: 2,
  KMF: 0,
  EUR: 2,
  USD: 2,
};

export class AmountError extends Error {
  override name = "AmountError";
}

/** Convertit une chaîne décimale ("1234.5", "-12", "1 200,50") en unités mineures (10^-4). */
export function toMinor(input: string | bigint): bigint {
  if (typeof input === "bigint") return input * FACTOR;
  const text = input.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new AmountError(`Montant invalide : "${input}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = BigInt(m[2] ?? "0");
  const fracRaw = m[3] ?? "";
  if (fracRaw.length > SCALE) throw new AmountError(`Trop de décimales (max ${SCALE}) : "${input}"`);
  const frac = BigInt((fracRaw + "0".repeat(SCALE)).slice(0, SCALE));
  return sign * (whole * FACTOR + frac);
}

/** Chaîne canonique à 4 décimales, celle attendue par l'API ("1234.5000"). */
export function fromMinor(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Division entière arrondie au plus proche (demi vers l'infini), comme dans le ledger. */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (b < 0n ? -b : b)) return (a < 0n) !== (b < 0n) ? q - 1n : q + 1n;
  return q;
}

function roundMinor(minor: bigint, decimals: number): bigint {
  if (decimals >= SCALE) return minor;
  const step = 10n ** BigInt(SCALE - decimals);
  return divRound(minor, step) * step;
}

export interface FormatOptions {
  /** Langue d'affichage ; décide des séparateurs. Français par défaut. */
  locale?: Locale;
  /** Séparateur de milliers ; celui de la langue par défaut. */
  thousands?: string;
  /** Séparateur décimal ; celui de la langue par défaut. */
  decimal?: string;
  /** Affiche "—" pour zéro (tableaux comptables). */
  dashForZero?: boolean;
}

/**
 * Séparateurs par langue. Le français prend l'espace fine insécable (U+202F),
 * qui est la forme typographique correcte et ne laisse jamais « 1 234 » se
 * couper en fin de ligne.
 */
const PUNCTUATION: Record<Locale, { thousands: string; decimal: string }> = {
  fr: { thousands: "\u202f", decimal: "," },
  en: { thousands: ",", decimal: "." },
};

/**
 * Formate un montant : "1 235" / "1,235" pour XOF, "1 234,50" / "1,234.50"
 * pour EUR. Accepte une chaîne canonique ou un bigint d'unités mineures.
 */
export function formatAmount(value: string | bigint | null | undefined, currency = "XOF", opts: FormatOptions = {}): string {
  if (value === null || value === undefined || value === "") return "";
  const p = PUNCTUATION[opts.locale ?? DEFAULT_LOCALE];
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const minor = roundMinor(typeof value === "bigint" ? value : toMinor(value), decimals);
  if (minor === 0n && opts.dashForZero) return "—";
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = (abs / FACTOR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, opts.thousands ?? p.thousands);
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}${decimals > 0 ? (opts.decimal ?? p.decimal) + frac : ""}`;
}

export function addAmounts(...values: Array<string | bigint>): string {
  let acc = 0n;
  for (const v of values) acc += typeof v === "bigint" ? v : toMinor(v);
  return fromMinor(acc);
}

export function subAmounts(a: string | bigint, b: string | bigint): string {
  return fromMinor((typeof a === "bigint" ? a : toMinor(a)) - (typeof b === "bigint" ? b : toMinor(b)));
}

export function negate(a: string): string {
  return fromMinor(-toMinor(a));
}

export function isZero(a: string | bigint): boolean {
  return (typeof a === "bigint" ? a : toMinor(a)) === 0n;
}

export function isNegative(a: string | bigint): boolean {
  return (typeof a === "bigint" ? a : toMinor(a)) < 0n;
}

export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const x = toMinor(a);
  const y = toMinor(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Solde d'un compte à partir de ses totaux : renvoie le côté et la valeur absolue.
 * Débit > crédit → solde débiteur ("D"), sinon créditeur ("C") ; zéro → "D" à 0.
 */
export function balanceSide(debit: string, credit: string): { side: "D" | "C"; amount: string } {
  const diff = toMinor(debit) - toMinor(credit);
  if (diff < 0n) return { side: "C", amount: fromMinor(-diff) };
  return { side: "D", amount: fromMinor(diff) };
}

/** Vérifie qu'une saisie utilisateur est un montant valide et positif ; renvoie la chaîne canonique ou null. */
export function normalizeInput(input: string): string | null {
  if (input.trim() === "") return null;
  try {
    const minor = toMinor(input);
    return minor > 0n ? fromMinor(minor) : null;
  } catch {
    return null;
  }
}
