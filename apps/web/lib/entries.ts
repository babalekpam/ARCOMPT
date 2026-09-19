/** Aides partagées autour des écritures (client et serveur). */
import { addAmounts } from "./money";
import type { RecentEntry } from "./offline";
import type { JournalEntry } from "./types";

/** Total débit d'une écriture (somme des lignes), en chaîne canonique. */
export function entryTotal(entry: Pick<JournalEntry, "lines">): string {
  return addAmounts("0", ...entry.lines.map((l) => l.debit));
}

/** Projection d'une écriture API vers l'historique local chiffré. */
export function toRecentEntry(entry: JournalEntry): RecentEntry {
  return {
    id: entry.id,
    journalCode: entry.journalCode,
    date: entry.date,
    label: entry.label,
    status: entry.status,
    number: entry.number,
    totalDebit: entryTotal(entry),
    reversedByEntryId: entry.reversedByEntryId,
    updatedAt: new Date().toISOString(),
  };
}
