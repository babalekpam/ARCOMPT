import type { CountryPack } from "@arcompt/country-packs";
import type { Deadline, DeadlineStatus, TaxReturnKind } from "./types.js";

export interface CalendarOptions {
  /** Date du jour (ISO) pour le statut ; défaut : aujourd'hui. */
  today?: string;
  /** Déclarations déposées : une échéance est DONE si une déclaration du même type couvre sa période. */
  filed?: Array<{ kind: TaxReturnKind; periodFrom: string; periodTo: string }>;
  /** Fenêtre « bientôt dû » en jours (défaut 15). */
  soonDays?: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return `${year}-${pad(month)}-${pad(d.getUTCDate())}`;
}

/** Jour `day` du mois, borné à la longueur du mois. */
function dayInMonth(year: number, month: number, day: number): string {
  const last = Number(lastDayOfMonth(year, month).slice(8));
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

/** Type de déclaration associé à une entrée de calendrier du pack (heuristique sur l'identifiant). */
export function kindForCalendarId(id: string): TaxReturnKind | null {
  const s = id.toLowerCase();
  if (s.includes("dsf") || s.includes("liasse") || s.includes("etats")) return "DSF";
  if (s.includes("vat") || s.includes("tva")) return "VAT";
  if (s.includes("retenue") || s.includes("withholding")) return "WITHHOLDING";
  if (s.includes("is") || s.includes("acompte") || s.includes("bic")) return "IS_INSTALMENT";
  return null;
}

/**
 * Développe le calendrier du pack en échéances datées pour une année civile :
 *  - MONTHLY : le jour `due` de chaque mois, pour le mois précédent ;
 *  - QUARTERLY : le jour `due` des mois 1, 4, 7, 10, pour le trimestre précédent ;
 *  - ANNUAL : la date fixe « MM-JJ », pour l'exercice précédent.
 */
export function filingCalendar(pack: CountryPack, year: number, opts: CalendarOptions = {}): Deadline[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const soonDays = opts.soonDays ?? 15;
  const out: Deadline[] = [];
  for (const entry of pack.calendar) {
    const kind = kindForCalendarId(entry.id);
    if (entry.frequency === "MONTHLY") {
      const day = Number(entry.due);
      for (let m = 1; m <= 12; m++) {
        const py = m === 1 ? year - 1 : year;
        const pm = m === 1 ? 12 : m - 1;
        out.push(deadline(entry, kind, `${py}-${pad(pm)}-01`, lastDayOfMonth(py, pm), `${py}-${pad(pm)}`, dayInMonth(year, m, day)));
      }
    } else if (entry.frequency === "QUARTERLY") {
      const day = Number(entry.due);
      for (const m of [1, 4, 7, 10]) {
        const py = m === 1 ? year - 1 : year;
        const q = m === 1 ? 4 : (m - 1) / 3;
        const firstMonth = (q - 1) * 3 + 1;
        out.push(deadline(entry, kind, `${py}-${pad(firstMonth)}-01`, lastDayOfMonth(py, firstMonth + 2), `${py}-T${q}`, dayInMonth(year, m, day)));
      }
    } else {
      const [mm, dd] = entry.due.split("-").map(Number);
      out.push(deadline(entry, kind, `${year - 1}-01-01`, `${year - 1}-12-31`, String(year - 1), dayInMonth(year, mm ?? 12, dd ?? 31)));
    }
  }
  return out
    .map((d) => ({ ...d, status: statusOf(d, today, soonDays, opts.filed ?? []) }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.calendarId.localeCompare(b.calendarId));
}

function deadline(entry: CountryPack["calendar"][number], kind: TaxReturnKind | null, periodFrom: string, periodTo: string, periodLabel: string, dueDate: string): Deadline {
  return { calendarId: entry.id, label: entry.label, frequency: entry.frequency, periodFrom, periodTo, periodLabel, dueDate, status: "UPCOMING", kind };
}

function statusOf(d: Deadline, today: string, soonDays: number, filed: NonNullable<CalendarOptions["filed"]>): DeadlineStatus {
  if (d.kind && filed.some((f) => f.kind === d.kind && f.periodFrom >= d.periodFrom && f.periodTo <= d.periodTo)) return "DONE";
  if (d.dueDate < today) return "OVERDUE";
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + soonDays);
  return d.dueDate <= soon.toISOString().slice(0, 10) ? "DUE_SOON" : "UPCOMING";
}
