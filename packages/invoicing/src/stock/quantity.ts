/**
 * Quantity : quantités de stock à 4 décimales sur bigint, jamais de flottants.
 *
 * Même représentation que `Money` (bigint à l'échelle 10^4, exactement le
 * NUMERIC(20,4) de la base), mais ce n'est pas un montant : une quantité n'a
 * pas de devise et ne s'additionne pas à un prix. Le type est donc distinct,
 * pour que le compilateur refuse de les mélanger.
 */

export const QUANTITY_SCALE = 4;
const FACTOR = 10n ** BigInt(QUANTITY_SCALE);

export class QuantityError extends Error {
  override name = "QuantityError";
}

export class Quantity {
  private constructor(readonly minor: bigint) {}

  static zero(): Quantity {
    return new Quantity(0n);
  }

  /** Construit depuis une chaîne décimale ("12", "0.5", "1250.7500"). */
  static parse(input: string | number | bigint | Quantity): Quantity {
    if (input instanceof Quantity) return input;
    if (typeof input === "bigint") return new Quantity(input * FACTOR);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new QuantityError(`Quantité invalide : ${input}`);
      const s = input.toFixed(QUANTITY_SCALE);
      if (Math.abs(Number(s) - input) > 1e-9) throw new QuantityError(`Quantité non représentable à ${QUANTITY_SCALE} décimales : ${input}`);
      return Quantity.parse(s);
    }
    const text = input.trim().replace(/\s/g, "").replace(",", ".");
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
    if (!m) throw new QuantityError(`Quantité invalide : "${input}"`);
    const fracRaw = m[3] ?? "";
    if (fracRaw.length > QUANTITY_SCALE) throw new QuantityError(`Trop de décimales (max ${QUANTITY_SCALE}) : "${input}"`);
    const sign = m[1] === "-" ? -1n : 1n;
    return new Quantity(sign * (BigInt(m[2] ?? "0") * FACTOR + BigInt((fracRaw + "0".repeat(QUANTITY_SCALE)).slice(0, QUANTITY_SCALE))));
  }

  static fromMinor(minor: bigint): Quantity {
    return new Quantity(minor);
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.minor + other.minor);
  }

  sub(other: Quantity): Quantity {
    return new Quantity(this.minor - other.minor);
  }

  neg(): Quantity {
    return new Quantity(-this.minor);
  }

  abs(): Quantity {
    return this.minor < 0n ? this.neg() : this;
  }

  min(other: Quantity): Quantity {
    return this.minor <= other.minor ? this : other;
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

  cmp(other: Quantity): -1 | 0 | 1 {
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  eq(other: Quantity): boolean {
    return this.minor === other.minor;
  }

  /** Représentation canonique à 4 décimales, celle stockée en base ("12.0000"). */
  toString(): string {
    const neg = this.minor < 0n;
    const abs = neg ? -this.minor : this.minor;
    return `${neg ? "-" : ""}${abs / FACTOR}.${(abs % FACTOR).toString().padStart(QUANTITY_SCALE, "0")}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * (a × b) ÷ c en entiers, arrondi au plus proche, demi vers l'infini — le même
 * arrondi que `Money.mulRate` et que le trigger de conversion en base.
 *
 * C'est l'unique opération d'où peut venir un centime de différence dans tout
 * le module : une valeur de sortie est toujours une part exacte d'une valeur
 * déjà arrondie, jamais un produit de coût unitaire flottant.
 */
export function mulDivRound(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new QuantityError("Division par zéro");
  const n = a * b;
  const q = n / c;
  const r = n % c;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (c < 0n ? -c : c)) return (n < 0n) !== (c < 0n) ? q - 1n : q + 1n;
  return q;
}
