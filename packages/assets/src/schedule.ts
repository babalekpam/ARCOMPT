import { CURRENCY_DECIMALS, Money, parseRate, RATE_SCALE } from "@arcompt/ledger";
import type { Prorata } from "./types.js";

/**
 * Plans d'amortissement : fonctions pures, sans base ni flottant.
 *
 * Conventions :
 *  - une période = un exercice comptable, borné par `fiscalYearEnd` (MM-JJ, défaut 12-31) ;
 *  - prorata temporis de la première période en jours réels (DAYS, jours de
 *    l'exercice au dénominateur) ou en mois entiers à compter du mois de mise
 *    en service (MONTHS) ;
 *  - chaque dotation est arrondie au nombre de décimales de la devise ;
 *    la dernière période absorbe l'écart d'arrondi de sorte que le cumul
 *    des dotations soit exactement égal à la base amortissable.
 */
export interface ScheduleInput {
  cost: Money | string;
  residualValue?: Money | string;
  /** Début d'amortissement (mise en service), date ISO. */
  startDate: string;
  durationMonths: number;
  currency: string;
  prorata?: Prorata;
  /** Fin d'exercice « MM-JJ » (défaut « 12-31 »). */
  fiscalYearEnd?: string;
  /** Dégressif : coefficient (« 1.5 », « 2 », « 2.5 ») ; défaut selon la durée. */
  coefficient?: string;
}

export interface SchedulePeriod {
  index: number;
  /** Bornes de l'exercice. */
  periodStart: string;
  periodEnd: string;
  /** Fenêtre réellement amortie dans la période (prorata de début / fin de plan). */
  activeFrom: string;
  activeTo: string;
  /** Base de calcul : base amortissable (linéaire) ou valeur nette au début de période (dégressif). */
  base: Money;
  dotation: Money;
  cumulative: Money;
  netBookValue: Money;
  method: "LINEAR" | "DEGRESSIVE";
  /** Fraction appliquée pour la période (traçabilité), ex. « 275/365 ». */
  fraction?: string;
}

const DAY_MS = 86_400_000;

export function toUtcDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  const d = toUtcDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** Ajoute des mois en bornant le jour à la longueur du mois cible (31/01 + 1 mois → 28/02). */
export function addMonths(s: string, n: number): string {
  const d = toUtcDate(s);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return isoDate(target);
}

/** Nombre de jours entre deux dates, bornes incluses. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / DAY_MS) + 1;
}

export function firstDayOfMonth(s: string): string {
  return `${s.slice(0, 7)}-01`;
}

export function lastDayOfMonth(s: string): string {
  const d = toUtcDate(s);
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** Première fin d'exercice supérieure ou égale à la date. */
export function fiscalYearEndOn(date: string, fiscalYearEnd = "12-31"): string {
  const year = Number(date.slice(0, 4));
  const candidate = `${year}-${fiscalYearEnd}`;
  return candidate >= date ? candidate : `${year + 1}-${fiscalYearEnd}`;
}

/** Début de l'exercice qui se termine à `end`. */
export function fiscalYearStartFor(end: string): string {
  return addDays(addMonths(end, -12), 1);
}

/** Fin d'exercice « MM-JJ » à partir d'une date de fin d'exercice complète. */
export function fiscalYearEndPattern(endDate: string): string {
  return endDate.slice(5);
}

/** Multiplie un montant par une fraction num/den avec arrondi arithmétique à 4 décimales. */
export function mulFraction(m: Money, num: bigint, den: bigint): Money {
  if (den === 0n) throw new Error("Division par zéro");
  return Money.fromMinor(divRound(m.minor * num, den));
}

function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (b < 0n ? -b : b)) return (a < 0n) !== (b < 0n) ? q - 1n : q + 1n;
  return q;
}

export function roundCurrency(m: Money, currency: string): Money {
  return m.roundTo(CURRENCY_DECIMALS[currency] ?? 2);
}

/** Coefficient dégressif usuel selon la durée d'utilisation (3–4 ans : 1,5 ; 5–6 ans : 2 ; au-delà : 2,5). */
export function defaultDegressiveCoefficient(durationMonths: number): string {
  if (durationMonths <= 48) return "1.5";
  if (durationMonths <= 72) return "2";
  return "2.5";
}

interface PeriodBounds {
  periodStart: string;
  periodEnd: string;
  activeFrom: string;
  activeTo: string;
}

/** Découpe [start, end] en exercices. */
function periodBounds(start: string, end: string, fiscalYearEnd: string): PeriodBounds[] {
  const out: PeriodBounds[] = [];
  let cursor = start;
  while (cursor <= end) {
    const fyEnd = fiscalYearEndOn(cursor, fiscalYearEnd);
    const periodStart = out.length === 0 ? fiscalYearStartFor(fyEnd) : cursor;
    out.push({ periodStart, periodEnd: fyEnd, activeFrom: cursor, activeTo: fyEnd < end ? fyEnd : end });
    cursor = addDays(fyEnd, 1);
  }
  return out;
}

function normalize(input: ScheduleInput): { cost: Money; residual: Money; base: Money; fyEnd: string; prorata: Prorata } {
  if (!Number.isInteger(input.durationMonths) || input.durationMonths <= 0) throw new Error("Durée d'amortissement invalide (mois entiers > 0)");
  const cost = Money.parse(input.cost);
  const residual = Money.parse(input.residualValue ?? "0");
  if (cost.isNegative() || residual.isNegative()) throw new Error("Coût et valeur résiduelle doivent être positifs");
  if (residual.cmp(cost) > 0) throw new Error("Valeur résiduelle supérieure au coût");
  return { cost, residual, base: cost.sub(residual), fyEnd: input.fiscalYearEnd ?? "12-31", prorata: input.prorata ?? "DAYS" };
}

/**
 * Amortissement linéaire (constant). Annuité = base × 12 / durée ; première
 * période au prorata ; dernière période = solde.
 */
export function linearSchedule(input: ScheduleInput): SchedulePeriod[] {
  const { cost, base, fyEnd, prorata } = normalize(input);
  if (base.isZero()) return [];
  const effectiveStart = prorata === "MONTHS" ? firstDayOfMonth(input.startDate) : input.startDate;
  const amortEnd = addDays(addMonths(effectiveStart, input.durationMonths), -1);
  const bounds = periodBounds(effectiveStart, amortEnd, fyEnd);
  const duration = BigInt(input.durationMonths);
  const out: SchedulePeriod[] = [];
  let cumulative = Money.zero();
  bounds.forEach((b, i) => {
    const last = i === bounds.length - 1;
    let dotation: Money;
    let fraction: string | undefined;
    if (last) {
      dotation = base.sub(cumulative);
      if (prorata === "MONTHS") fraction = `${monthsInclusive(b.activeFrom, b.activeTo)}/12`;
      else fraction = `${daysInclusive(b.activeFrom, b.activeTo)}/${daysInclusive(b.periodStart, b.periodEnd)}`;
    } else if (i === 0) {
      const [num, den] = prorata === "MONTHS" ? [BigInt(monthsInclusive(b.activeFrom, b.activeTo)), 12n] : [BigInt(daysInclusive(b.activeFrom, b.activeTo)), BigInt(daysInclusive(b.periodStart, b.periodEnd))];
      fraction = `${num}/${den}`;
      dotation = roundCurrency(mulFraction(base, 12n * num, duration * den), input.currency);
    } else {
      dotation = roundCurrency(mulFraction(base, 12n, duration), input.currency);
      fraction = "12/12";
    }
    if (dotation.isNegative()) dotation = Money.zero();
    cumulative = cumulative.add(dotation);
    out.push({ index: i + 1, ...b, base, dotation, cumulative, netBookValue: cost.sub(cumulative), method: "LINEAR", fraction });
  });
  return out;
}

/**
 * Amortissement dégressif : taux = taux linéaire × coefficient, appliqué à la
 * valeur nette ; bascule en linéaire (VNC / annuités restantes) dès que
 * celui-ci devient supérieur. Prorata de la première annuité en mois entiers
 * (usage), la première annuité partielle compte pour une annuité.
 */
export function degressiveSchedule(input: ScheduleInput): SchedulePeriod[] {
  const { cost, base, fyEnd } = normalize(input);
  if (base.isZero()) return [];
  const coefficient = parseRate(input.coefficient ?? defaultDegressiveCoefficient(input.durationMonths));
  const rateFactor = 10n ** BigInt(RATE_SCALE);
  const duration = BigInt(input.durationMonths);
  const annuities = Math.ceil(input.durationMonths / 12);
  const effectiveStart = firstDayOfMonth(input.startDate);
  // Bornes : `annuities` exercices à partir de la mise en service.
  const bounds: PeriodBounds[] = [];
  let cursor = effectiveStart;
  for (let k = 0; k < annuities; k++) {
    const end = fiscalYearEndOn(cursor, fyEnd);
    bounds.push({ periodStart: k === 0 ? fiscalYearStartFor(end) : cursor, periodEnd: end, activeFrom: cursor, activeTo: end });
    cursor = addDays(end, 1);
  }
  const out: SchedulePeriod[] = [];
  let cumulative = Money.zero();
  let remaining = base;
  let linearMode = false;
  bounds.forEach((b, i) => {
    const remainingAnnuities = BigInt(annuities - i);
    const last = i === bounds.length - 1;
    let dotation: Money;
    let fraction: string | undefined;
    if (last) {
      dotation = remaining;
      fraction = "solde";
    } else {
      const linearAlt = mulFraction(remaining, 1n, remainingAnnuities);
      const months = i === 0 ? BigInt(monthsInclusive(b.activeFrom, b.activeTo)) : 12n;
      // La bascule compare le taux dégressif plein au taux linéaire sur les annuités restantes ; le prorata ne s'applique qu'au montant.
      const degFull = mulFraction(remaining, 12n * coefficient, duration * rateFactor);
      const deg = mulFraction(remaining, 12n * coefficient * months, duration * rateFactor * 12n);
      if (!linearMode && linearAlt.cmp(degFull) >= 0) linearMode = true;
      dotation = roundCurrency(linearMode ? linearAlt : deg, input.currency);
      fraction = linearMode ? `1/${remainingAnnuities}` : `taux ${coefficient * 12n}/${duration * rateFactor} × ${months}/12`;
    }
    if (dotation.cmp(remaining) > 0) dotation = remaining;
    cumulative = cumulative.add(dotation);
    remaining = remaining.sub(dotation);
    out.push({ index: i + 1, ...b, base: cost.sub(cumulative.sub(dotation)), dotation, cumulative, netBookValue: cost.sub(cumulative), method: "DEGRESSIVE", fraction });
  });
  return out;
}

/** Nombre de mois civils couverts, bornes incluses (mois de début et mois de fin comptent). */
export function monthsInclusive(from: string, to: string): number {
  const a = toUtcDate(from);
  const b = toUtcDate(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

/** Plan selon la méthode ; vide pour NONE. */
export function computeSchedule(method: "LINEAR" | "DEGRESSIVE" | "NONE", input: ScheduleInput): SchedulePeriod[] {
  if (method === "NONE") return [];
  return method === "LINEAR" ? linearSchedule(input) : degressiveSchedule(input);
}

/**
 * Part d'une annuité acquise à une date intermédiaire (situation mensuelle,
 * cession en cours d'exercice) : proportion en jours de la fenêtre active.
 * À la fin de la fenêtre, la totalité de l'annuité est due.
 */
export function accruedPortion(period: SchedulePeriod, upTo: string, currency: string): Money {
  if (upTo >= period.activeTo) return period.dotation;
  if (upTo < period.activeFrom) return Money.zero();
  const num = BigInt(daysInclusive(period.activeFrom, upTo));
  const den = BigInt(daysInclusive(period.activeFrom, period.activeTo));
  return roundCurrency(mulFraction(period.dotation, num, den), currency);
}
