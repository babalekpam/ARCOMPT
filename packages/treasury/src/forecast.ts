// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money } from "@arcompt/ledger";

/**
 * Prévision de trésorerie à 13 semaines : fonction pure.
 * Combine le solde de départ, les créances et dettes ouvertes (par date
 * d'échéance) et les flux récurrents (paie, loyer, TVA…) en tranches
 * hebdomadaires ouverture / encaissements / décaissements / clôture.
 */
export interface ForecastItem {
  dueDate: string; // ISO
  amount: Money | string; // positif
  label?: string;
}

export interface RecurringItem {
  label: string;
  amount: Money | string; // positif
  direction: "IN" | "OUT";
  frequency: "WEEKLY" | "MONTHLY";
  /** MONTHLY : jour du mois (1–31, borné au dernier jour du mois). */
  dayOfMonth?: number;
  /** WEEKLY : jour de semaine (0 = dimanche … 6 = samedi). */
  weekday?: number;
  startDate?: string;
  endDate?: string;
}

export interface ForecastInputs {
  openingBalance: Money | string;
  receivables?: ForecastItem[];
  payables?: ForecastItem[];
  recurring?: RecurringItem[];
  /** Nombre de semaines (défaut 13). */
  weeks?: number;
  /** Seuil d'alerte : semaine dont la clôture passe sous ce montant (défaut 0). */
  minimumBalance?: Money | string;
}

export interface ForecastLine {
  label: string;
  date: string;
  amount: string; // signé
  kind: "RECEIVABLE" | "PAYABLE" | "RECURRING";
  overdue?: boolean;
}

export interface ForecastWeek {
  index: number;
  from: string;
  to: string;
  opening: string;
  inflows: string;
  outflows: string; // positif
  closing: string;
  items: ForecastLine[];
}

export interface Forecast {
  asOf: string;
  horizonEnd: string;
  weeks: ForecastWeek[];
  lowestBalance: string;
  lowestWeek: number;
  /** Première semaine dont la clôture passe sous le seuil, sinon null. */
  firstWeekBelowMinimum: number | null;
  /** Flux à échéance au-delà de l'horizon (non répartis). */
  beyondHorizon: { inflows: string; outflows: string };
}

export function addDays(iso: string, days: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days));
  return d.toISOString().slice(0, 10);
}

function isoOf(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Occurrences d'un flux récurrent entre `from` et `to` inclus. */
export function recurringDates(item: RecurringItem, from: string, to: string): string[] {
  const start = item.startDate && item.startDate > from ? item.startDate : from;
  const end = item.endDate && item.endDate < to ? item.endDate : to;
  if (start > end) return [];
  const out: string[] = [];
  if (item.frequency === "WEEKLY") {
    const wanted = item.weekday ?? weekdayOf(start);
    let d = start;
    while (weekdayOf(d) !== wanted) d = addDays(d, 1);
    for (; d <= end; d = addDays(d, 7)) out.push(d);
  } else {
    const day = Math.min(Math.max(item.dayOfMonth ?? 1, 1), 31);
    let y = Number(start.slice(0, 4));
    let m = Number(start.slice(5, 7)) - 1;
    for (let guard = 0; guard < 60; guard++) {
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const d = isoOf(y, m, Math.min(day, lastDay));
      if (d > end) break;
      if (d >= start) out.push(d);
      m++;
      if (m > 11) {
        m = 0;
        y++;
      }
    }
  }
  return out;
}

export function forecast13Weeks(asOf: string, inputs: ForecastInputs): Forecast {
  const weeksCount = Math.max(1, Math.min(inputs.weeks ?? 13, 52));
  const horizonEnd = addDays(asOf, weeksCount * 7 - 1);
  const minimum = Money.parse(inputs.minimumBalance ?? "0");

  const lines: ForecastLine[] = [];
  let beyondIn = Money.zero();
  let beyondOut = Money.zero();
  const place = (date: string, amount: Money, label: string, kind: ForecastLine["kind"]) => {
    if (date > horizonEnd) {
      if (amount.isNegative()) beyondOut = beyondOut.add(amount.abs());
      else beyondIn = beyondIn.add(amount);
      return;
    }
    // Échéances passées non réglées : attendues dès la première semaine, signalées.
    const overdue = date < asOf;
    lines.push({ label, date: overdue ? asOf : date, amount: amount.toString(), kind, ...(overdue ? { overdue: true } : {}) });
  };
  for (const r of inputs.receivables ?? []) place(r.dueDate, Money.parse(r.amount).abs(), r.label ?? "Créance", "RECEIVABLE");
  for (const p of inputs.payables ?? []) place(p.dueDate, Money.parse(p.amount).abs().neg(), p.label ?? "Dette", "PAYABLE");
  for (const rec of inputs.recurring ?? []) {
    const amount = Money.parse(rec.amount).abs();
    for (const d of recurringDates(rec, asOf, horizonEnd)) place(d, rec.direction === "OUT" ? amount.neg() : amount, rec.label, "RECURRING");
  }
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const weeks: ForecastWeek[] = [];
  let balance = Money.parse(inputs.openingBalance);
  let lowest = balance;
  let lowestWeek = 0;
  let firstBelow: number | null = null;
  for (let i = 0; i < weeksCount; i++) {
    const from = addDays(asOf, i * 7);
    const to = addDays(asOf, i * 7 + 6);
    const items = lines.filter((l) => l.date >= from && l.date <= to);
    let inflows = Money.zero();
    let outflows = Money.zero();
    for (const it of items) {
      const m = Money.parse(it.amount);
      if (m.isNegative()) outflows = outflows.add(m.abs());
      else inflows = inflows.add(m);
    }
    const opening = balance;
    balance = opening.add(inflows).sub(outflows);
    if (balance.cmp(lowest) < 0) {
      lowest = balance;
      lowestWeek = i + 1;
    }
    if (firstBelow === null && balance.cmp(minimum) < 0) firstBelow = i + 1;
    weeks.push({ index: i + 1, from, to, opening: opening.toString(), inflows: inflows.toString(), outflows: outflows.toString(), closing: balance.toString(), items });
  }
  return {
    asOf,
    horizonEnd,
    weeks,
    lowestBalance: lowest.toString(),
    lowestWeek,
    firstWeekBelowMinimum: firstBelow,
    beyondHorizon: { inflows: beyondIn.toString(), outflows: beyondOut.toString() },
  };
}
