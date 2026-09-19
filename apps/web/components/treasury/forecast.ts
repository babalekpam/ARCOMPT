/**
 * Aides pures pour la prévision 13 semaines : échelle des barres CSS (sans
 * bibliothèque graphique) et construction des flux à partir des documents
 * ouverts. Aucune arithmétique en flottant sur les montants : on ne convertit
 * en nombre qu'au moment de calculer une largeur en pour cent.
 */
import { compareAmounts, fromMinor, isNegative, toMinor } from "../../lib/money";
import type { ForecastWeek } from "./types";

export interface BarScale {
  /** Montant absolu maximal rencontré (chaîne canonique) ; "0.0000" si tout est nul. */
  max: string;
  /** Largeur en pour cent (0–100) d'un montant ; 0 quand `max` est nul. */
  widthOf: (amount: string) => number;
}

/** Échelle commune aux barres encaissements / décaissements / clôture d'une prévision. */
export function barScale(weeks: Pick<ForecastWeek, "inflows" | "outflows" | "closing">[]): BarScale {
  let max = 0n;
  for (const w of weeks) {
    for (const v of [w.inflows, w.outflows, w.closing]) {
      const m = toMinor(v);
      const abs = m < 0n ? -m : m;
      if (abs > max) max = abs;
    }
  }
  const widthOf = (amount: string): number => {
    if (max === 0n) return 0;
    const m = toMinor(amount);
    const abs = m < 0n ? -m : m;
    // Pour cent entier : (abs × 100) / max en bigint, borné à 100.
    const pct = Number((abs * 100n) / max);
    return Math.min(100, Math.max(0, pct));
  };
  return { max: fromMinor(max), widthOf };
}

/** Semaines dont la clôture passe sous le seuil (ou sous zéro sans seuil). */
export function weeksBelow(weeks: Pick<ForecastWeek, "index" | "closing">[], minimum?: string): number[] {
  const floor = minimum && minimum.trim() !== "" ? minimum : "0";
  return weeks.filter((w) => compareAmounts(w.closing, floor) < 0).map((w) => w.index);
}

export interface OpenDocumentLike {
  number: string | null;
  partnerName: string;
  dueDate: string | null;
  issueDate: string;
  outstanding: string;
  status: string;
}

/** Transforme des documents ouverts en flux de prévision (échéance = dueDate, sinon date d'émission). */
export function flowsFromDocuments(docs: OpenDocumentLike[], openStatuses: string[]): Array<{ dueDate: string; amount: string; label: string }> {
  const out: Array<{ dueDate: string; amount: string; label: string }> = [];
  for (const d of docs) {
    if (!openStatuses.includes(d.status)) continue;
    if (isNegative(d.outstanding) || toMinor(d.outstanding) === 0n) continue;
    out.push({ dueDate: d.dueDate ?? d.issueDate, amount: d.outstanding, label: `${d.number ?? "—"} · ${d.partnerName}`.slice(0, 120) });
  }
  return out;
}
