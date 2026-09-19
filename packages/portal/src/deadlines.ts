import type { CountryPack } from "@arcompt/country-packs";
import type { Deadline } from "./types.js";

/**
 * Prochaines échéances déclaratives d'un dossier, calculées depuis le
 * calendrier du pack pays (données déclaratives, jamais de code pays en dur).
 *  - MONTHLY   : jour `due` de chaque mois ;
 *  - QUARTERLY : jour `due` du mois qui suit chaque trimestre civil (janv., avr., juil., oct.) ;
 *  - ANNUAL    : date fixe `MM-JJ`.
 */
export function nextDeadlines(pack: Pick<CountryPack, "calendar">, from: Date, horizonDays = 90, taxRegime?: string | null): Deadline[] {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = start + horizonDays * 86_400_000;
  const out: Deadline[] = [];
  for (const item of pack.calendar) {
    if (item.applies_to && item.applies_to.length > 0 && taxRegime && !item.applies_to.includes(taxRegime)) continue;
    for (const due of occurrences(item, start, end)) {
      out.push({ id: item.id, label: item.label, frequency: item.frequency, dueDate: iso(due), daysLeft: Math.round((due - start) / 86_400_000) });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
}

function occurrences(item: CountryPack["calendar"][number], start: number, end: number): number[] {
  const dates: number[] = [];
  const y0 = new Date(start).getUTCFullYear();
  const m0 = new Date(start).getUTCMonth();
  if (item.frequency === "ANNUAL") {
    const m = /^(\d{2})-(\d{2})$/.exec(item.due);
    if (!m) return dates;
    for (let y = y0; y <= y0 + 1; y++) push(dates, clampedDate(y, Number(m[1]) - 1, Number(m[2])), start, end);
    return dates;
  }
  const day = Number(item.due);
  if (!Number.isInteger(day) || day < 1) return dates;
  for (let i = 0; i < 15; i++) {
    const month = m0 + i;
    const y = y0 + Math.floor(month / 12);
    const m = ((month % 12) + 12) % 12;
    if (item.frequency === "QUARTERLY" && m % 3 !== 0) continue;
    push(dates, clampedDate(y, m, day), start, end);
  }
  return dates;
}

function clampedDate(y: number, m: number, d: number): number {
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d, lastDay));
}

function push(dates: number[], t: number, start: number, end: number): void {
  if (t >= start && t <= end) dates.push(t);
}

function iso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
