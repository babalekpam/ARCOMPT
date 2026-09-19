import type { Money } from "@arcompt/ledger";

/**
 * Appariement pur entre lignes de relevé et lignes du grand livre.
 *
 * Règles :
 *  1. le montant doit être strictement égal (jamais d'approximation) ;
 *  2. la date de l'écriture doit être dans une fenêtre de ± N jours (3 par défaut) ;
 *  3. le score combine proximité de date, similarité des libellés et unicité
 *     du candidat ; on n'apparie jamais sous le seuil (0,9 par défaut) ;
 *  4. deux candidats trop proches → ambiguïté, rien n'est apparié
 *     automatiquement (le LLM ou l'humain tranche).
 */
export interface MatchOptions {
  /** Score minimal pour un appariement automatique (défaut 0,9). */
  threshold?: number;
  /** Fenêtre de dates en jours (défaut 3). */
  dateWindowDays?: number;
  /** Écart minimal entre les deux meilleurs candidats pour trancher (défaut 0,05). */
  ambiguityMargin?: number;
}

export interface MatchTransaction {
  id: string;
  date: string;
  amount: Money;
  label: string;
  reference?: string | null;
}

export interface MatchCandidateLine {
  lineId: string;
  date: string;
  amount: Money;
  label: string;
  entryLabel?: string;
  reference?: string | null;
}

export interface ScoredCandidate {
  lineId: string;
  score: number;
  dateDelta: number;
  labelSimilarity: number;
  unique: boolean;
}

export type MatchReason = "MATCHED" | "NO_CANDIDATE" | "BELOW_THRESHOLD" | "AMBIGUOUS";

export interface MatchDecision {
  transactionId: string;
  /** Candidats de même montant dans la fenêtre, meilleurs en premier. */
  candidates: ScoredCandidate[];
  best: ScoredCandidate | null;
  autoMatch: boolean;
  reason: MatchReason;
}

export const DEFAULT_MATCH_OPTIONS: Required<MatchOptions> = { threshold: 0.9, dateWindowDays: 3, ambiguityMargin: 0.05 };

const STOPWORDS = new Set([
  "vir", "virement", "sepa", "de", "du", "la", "le", "les", "des", "un", "une", "au", "aux", "et", "en", "pour", "par", "sur",
  "ref", "reference", "paiement", "reglement", "facture", "fact", "fac", "cheque", "chq", "prlv", "prelevement", "carte", "cb",
  "retrait", "depot", "versement", "recu", "envoye", "operation", "op", "transfert", "mobile", "money", "the", "of", "to", "from",
  "payment", "transfer", "inv", "invoice", "sas", "sarl", "sa", "ets", "ste", "societe", "company", "co", "ltd", "client", "fournisseur",
]);

/** Minuscule, sans accents, alphanumérique ; jetons de deux caractères ou plus. */
export function normalizeLabel(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Similarité cosinus sur les ensembles de jetons significatifs (0 à 1). */
export function labelSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeLabel(a).filter((t) => !STOPWORDS.has(t)));
  const tb = new Set(normalizeLabel(b).filter((t) => !STOPWORDS.has(t)));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.sqrt(ta.size * tb.size);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const db = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((db - da) / 86_400_000);
}

function lineText(l: MatchCandidateLine): string {
  return [l.label, l.entryLabel ?? "", l.reference ?? ""].join(" ");
}

function txText(t: MatchTransaction): string {
  return [t.label, t.reference ?? ""].join(" ");
}

/**
 * Score d'un candidat : 0,5 pour le montant exact, jusqu'à 0,3 pour la
 * proximité de date, jusqu'à 0,2 pour les libellés, +0,1 si le couple est
 * unique (un seul candidat pour la ligne et une seule ligne pour le candidat).
 */
export function scoreCandidate(tx: MatchTransaction, line: MatchCandidateLine, unique: boolean, opts: Required<MatchOptions>): ScoredCandidate {
  const dateDelta = Math.abs(daysBetween(tx.date, line.date));
  const dateScore = 0.3 * (1 - dateDelta / (2 * (opts.dateWindowDays + 1)));
  const similarity = labelSimilarity(txText(tx), lineText(line));
  const score = Math.min(1, 0.5 + dateScore + 0.2 * similarity + (unique ? 0.1 : 0));
  return { lineId: line.lineId, score: round4(score), dateDelta, labelSimilarity: round4(similarity), unique };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function amountCandidates(tx: MatchTransaction, lines: MatchCandidateLine[], window: number): MatchCandidateLine[] {
  return lines.filter((l) => l.amount.eq(tx.amount) && Math.abs(daysBetween(tx.date, l.date)) <= window);
}

/**
 * Décide, pour chaque ligne de relevé, du candidat à apparier. Attribution
 * gloutonne par score décroissant : une ligne du grand livre n'est prise qu'une fois.
 */
export function matchTransactions(transactions: MatchTransaction[], lines: MatchCandidateLine[], options: MatchOptions = {}): MatchDecision[] {
  const opts: Required<MatchOptions> = { ...DEFAULT_MATCH_OPTIONS, ...stripUndefined(options) };
  const candidatesByTx = new Map<string, MatchCandidateLine[]>();
  const txCountByLine = new Map<string, number>();
  for (const tx of transactions) {
    const cands = amountCandidates(tx, lines, opts.dateWindowDays);
    candidatesByTx.set(tx.id, cands);
    for (const c of cands) txCountByLine.set(c.lineId, (txCountByLine.get(c.lineId) ?? 0) + 1);
  }

  const scored = transactions.map((tx) => {
    const cands = candidatesByTx.get(tx.id) ?? [];
    const list = cands
      .map((l) => scoreCandidate(tx, l, cands.length === 1 && txCountByLine.get(l.lineId) === 1, opts))
      .sort((a, b) => b.score - a.score || a.dateDelta - b.dateDelta);
    return { tx, list };
  });
  // Les lignes les plus sûres d'abord, pour qu'un doublon ne vole pas la ligne d'un meilleur candidat.
  scored.sort((a, b) => (b.list[0]?.score ?? 0) - (a.list[0]?.score ?? 0));

  const taken = new Set<string>();
  const decisions = new Map<string, MatchDecision>();
  for (const { tx, list } of scored) {
    const available = list.filter((c) => !taken.has(c.lineId));
    const best = available[0] ?? null;
    let reason: MatchReason;
    let autoMatch = false;
    if (!best) reason = list.length === 0 ? "NO_CANDIDATE" : "AMBIGUOUS";
    else if (best.score < opts.threshold) reason = "BELOW_THRESHOLD";
    else if (available[1] && best.score - available[1].score < opts.ambiguityMargin) reason = "AMBIGUOUS";
    else {
      reason = "MATCHED";
      autoMatch = true;
      taken.add(best.lineId);
    }
    decisions.set(tx.id, { transactionId: tx.id, candidates: available, best, autoMatch, reason });
  }
  return transactions.map((tx) => decisions.get(tx.id)!);
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
