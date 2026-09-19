import { createHash } from "node:crypto";
import type { JournalEntry } from "./types.js";

/**
 * Chaînage des écritures validées : chaque écriture stocke le hash de la
 * précédente du même journal. Le hash couvre le contenu comptable de
 * l'écriture (pas les champs techniques), dans une sérialisation canonique.
 */
export function canonicalEntryPayload(entry: JournalEntry): string {
  const lines = [...entry.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => ({
      n: l.lineNo,
      a: l.accountNumber,
      p: l.partnerId,
      d: l.debit.toString(),
      c: l.credit.toString(),
      cur: l.currency,
      r: l.rate,
      an: l.analyticCode,
      v: l.vatCode,
      l: l.label,
    }));
  return JSON.stringify({
    t: entry.tenantId,
    j: entry.journalCode,
    n: entry.number,
    d: entry.date,
    ref: entry.reference,
    l: entry.label,
    s: entry.source,
    rev: entry.reversesEntryId,
    lines,
  });
}

export function computeEntryHash(entry: JournalEntry, prevHash: string | null): string {
  const h = createHash("sha256");
  h.update(prevHash ?? "GENESIS");
  h.update("\n");
  h.update(canonicalEntryPayload(entry));
  return h.digest("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
