import { Money } from "@arcompt/ledger";
import type { DocumentExtraction, EntryProposal } from "./schemas.js";

export interface GuardIssue {
  code: "HT_TVA_TTC" | "UNKNOWN_ACCOUNT" | "NOT_POSTABLE" | "UNBALANCED" | "LOW_CONFIDENCE" | "DUPLICATE" | "MISSING_AMOUNT";
  message: string;
}

/** Contrôle HT + TVA = TTC (tolérance d'arrondi d'une unité de devise). */
export function checkExtractionArithmetic(x: DocumentExtraction, tolerance = "1"): GuardIssue[] {
  if (x.amount_excl_tax === null || x.amount_incl_tax === null) {
    return [{ code: "MISSING_AMOUNT", message: "Montant HT ou TTC non lu : saisie manuelle requise" }];
  }
  const ht = Money.parse(x.amount_excl_tax);
  const tva = Money.parse(x.vat_amount ?? "0");
  const ttc = Money.parse(x.amount_incl_tax);
  const diff = ht.add(tva).sub(ttc).abs();
  if (diff.cmp(Money.parse(tolerance)) > 0) {
    return [{ code: "HT_TVA_TTC", message: `HT (${ht}) + TVA (${tva}) ≠ TTC (${ttc}) : écart ${diff}` }];
  }
  return [];
}

export interface ChartLookup {
  (accountNumber: string): { postable: boolean } | null;
}

/** Le compte proposé doit exister dans le plan du dossier et être imputable ; l'écriture doit être équilibrée. */
export function checkProposal(p: EntryProposal, chart: ChartLookup, minConfidence = 0.85): GuardIssue[] {
  const issues: GuardIssue[] = [];
  let d = Money.zero();
  let c = Money.zero();
  for (const l of p.lines) {
    const acc = chart(l.account_number);
    if (!acc) issues.push({ code: "UNKNOWN_ACCOUNT", message: `Compte ${l.account_number} absent du plan : proposition rejetée` });
    else if (!acc.postable) issues.push({ code: "NOT_POSTABLE", message: `Compte ${l.account_number} non imputable` });
    if (l.debit) d = d.add(Money.parse(l.debit));
    if (l.credit) c = c.add(Money.parse(l.credit));
  }
  if (!d.eq(c)) issues.push({ code: "UNBALANCED", message: `Proposition déséquilibrée : ${d} ≠ ${c}` });
  if (p.confidence < minConfidence) issues.push({ code: "LOW_CONFIDENCE", message: `Confiance ${p.confidence} < ${minConfidence} : file de revue du comptable` });
  return issues;
}

/** Décision de routage : validation en un geste ou file de revue. */
export function routeProposal(issues: GuardIssue[]): "ONE_TAP_VALIDATION" | "REVIEW_QUEUE" | "REJECTED" {
  if (issues.some((i) => i.code === "UNKNOWN_ACCOUNT" || i.code === "UNBALANCED" || i.code === "HT_TVA_TTC")) return "REJECTED";
  if (issues.length > 0) return "REVIEW_QUEUE";
  return "ONE_TAP_VALIDATION";
}

/** Clé de détection de doublon : (tiers, montant TTC, date). Le hash SHA-256 du fichier est vérifié en base (contrainte unique). */
export function duplicateKey(x: Pick<DocumentExtraction, "supplier_name" | "amount_incl_tax" | "date">): string | null {
  if (!x.amount_incl_tax || !x.date) return null;
  const name = (x.supplier_name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${name}|${Money.parse(x.amount_incl_tax).toString()}|${x.date}`;
}
