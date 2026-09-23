// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Money : montants à 4 décimales sur bigint, jamais de flottants.
 *
 * Le montant est stocké en « unités mineures » à l'échelle 10^4, ce qui
 * correspond exactement au NUMERIC(20,4) de la base. Les devises sans
 * décimales (XOF, XAF) et les devises à 2 décimales (EUR, USD) partagent
 * la même représentation ; l'arrondi d'affichage dépend de la devise.
 */

export const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

export type CurrencyCode = string; // ISO 4217 : XOF, XAF, GNF, CDF, EUR, USD…

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

export class Money {
  private constructor(readonly minor: bigint) {}

  static zero(): Money {
    return new Money(0n);
  }

  /** Construit depuis une chaîne décimale ("1234.5", "-12", "0.0001"). */
  static parse(input: string | number | bigint | Money): Money {
    if (input instanceof Money) return input;
    if (typeof input === "bigint") return new Money(input * FACTOR);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new MoneyError(`Montant invalide : ${input}`);
      // Un nombre n'est accepté que s'il est représentable exactement à 4 décimales.
      const s = input.toFixed(SCALE);
      if (Math.abs(Number(s) - input) > 1e-9) {
        throw new MoneyError(`Montant non représentable à ${SCALE} décimales : ${input}`);
      }
      return Money.parse(s);
    }
    const text = input.trim().replace(/\s/g, "").replace(",", ".");
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
    if (!m) throw new MoneyError(`Montant invalide : "${input}"`);
    const sign = m[1] === "-" ? -1n : 1n;
    const whole = BigInt(m[2] ?? "0");
    const fracRaw = m[3] ?? "";
    if (fracRaw.length > SCALE) {
      throw new MoneyError(`Trop de décimales (max ${SCALE}) : "${input}"`);
    }
    const frac = BigInt((fracRaw + "0".repeat(SCALE)).slice(0, SCALE));
    return new Money(sign * (whole * FACTOR + frac));
  }

  static fromMinor(minor: bigint): Money {
    return new Money(minor);
  }

  add(other: Money): Money {
    return new Money(this.minor + other.minor);
  }

  sub(other: Money): Money {
    return new Money(this.minor - other.minor);
  }

  neg(): Money {
    return new Money(-this.minor);
  }

  abs(): Money {
    return this.minor < 0n ? this.neg() : this;
  }

  /** Multiplie par un taux exprimé en chaîne décimale ("0.18", jusqu'à 10 décimales) avec arrondi au plus proche. */
  mulRate(rate: string | number): Money {
    const r = parseRate(rate);
    return new Money(divRound(this.minor * r, RATE_FACTOR));
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  cmp(other: Money): -1 | 0 | 1 {
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  eq(other: Money): boolean {
    return this.minor === other.minor;
  }

  /** Arrondit au nombre de décimales de la devise (arrondi arithmétique). */
  roundTo(decimals: number): Money {
    if (decimals >= SCALE) return this;
    const step = 10n ** BigInt(SCALE - decimals);
    return new Money(divRound(this.minor, step) * step);
  }

  /** Représentation canonique à 4 décimales, celle stockée en base ("1234.5000"). */
  toString(): string {
    const neg = this.minor < 0n;
    const abs = neg ? -this.minor : this.minor;
    const whole = abs / FACTOR;
    const frac = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${neg ? "-" : ""}${whole}.${frac}`;
  }

  /** Représentation d'affichage selon la devise ("1 235" pour XOF, "1234.50" pour EUR). */
  format(currency: CurrencyCode): string {
    const decimals = CURRENCY_DECIMALS[currency] ?? 2;
    const rounded = this.roundTo(decimals);
    const neg = rounded.minor < 0n;
    const abs = neg ? -rounded.minor : rounded.minor;
    const whole = (abs / FACTOR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    const frac = (abs % FACTOR).toString().padStart(SCALE, "0").slice(0, decimals);
    return `${neg ? "-" : ""}${whole}${decimals > 0 ? "." + frac : ""}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

export const RATE_SCALE = 10;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

/** Taux ou coefficient à 10 décimales, en bigint (0.18 → 1800000000n). */
export function parseRate(input: string | number): bigint {
  const text = (typeof input === "number" ? input.toString() : input).trim().replace(",", ".");
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new MoneyError(`Taux invalide : "${input}"`);
  const fracRaw = m[3] ?? "";
  if (fracRaw.length > RATE_SCALE) throw new MoneyError(`Taux : trop de décimales (max ${RATE_SCALE}) : "${input}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  return sign * (BigInt(m[2] ?? "0") * RATE_FACTOR + BigInt((fracRaw + "0".repeat(RATE_SCALE)).slice(0, RATE_SCALE)));
}

/** Représentation canonique d'un taux à 10 décimales ("655.9570000000"). */
export function formatRate(r: bigint): string {
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const whole = abs / RATE_FACTOR;
  const frac = (abs % RATE_FACTOR).toString().padStart(RATE_SCALE, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * Taux inverse, arrondi à 10 décimales. Utile quand seul le sens opposé d'une
 * paire est connu ; la conversion perd alors l'exactitude de la parité, ce que
 * l'appelant doit signaler (le taux effectivement appliqué est celui-ci, pas
 * celui d'origine).
 */
export function invertRate(rate: string | number): string {
  const r = parseRate(rate);
  if (r <= 0n) throw new MoneyError(`Taux non inversible : "${rate}"`);
  return formatRate(divRound(RATE_FACTOR * RATE_FACTOR, r));
}

/** Multiplie deux taux (chaînage de paires) avec arrondi à 10 décimales. */
export function composeRates(a: string | number, b: string | number): string {
  return formatRate(divRound(parseRate(a) * parseRate(b), RATE_FACTOR));
}

export class MoneyError extends Error {
  override name = "MoneyError";
}

/** Division entière arrondie au plus proche (demi vers l'infini). */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (b < 0n ? -b : b)) {
    return (a < 0n) !== (b < 0n) ? q - 1n : q + 1n;
  }
  return q;
}

export function sum(values: Iterable<Money>): Money {
  let acc = 0n;
  for (const v of values) acc += v.minor;
  return Money.fromMinor(acc);
}
