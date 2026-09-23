// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money } from "@arcompt/ledger";
import type { StatementRow } from "./types.js";

/**
 * Parseur CSV de relevés bancaires, pur et tolérant :
 *  - séparateur détecté (`;` `,` tabulation `|`) ;
 *  - montants « 1 234,56 », « 1.234,56 », « 25,000 », « (500) », « 500- », avec devise ;
 *  - dates JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AA, AAAA-MM-JJ ;
 *  - colonnes débit/crédit, montant signé, ou montant + sens (D/C) ;
 *  - en-têtes reconnus par synonymes (français / anglais), lignes de préambule ignorées.
 *
 * Aucun flottant : les montants passent par Money.
 */
export type CsvColumnKey = "date" | "valueDate" | "label" | "amount" | "debit" | "credit" | "reference" | "externalId" | "direction";
export type CsvLayout = "SIGNED" | "DEBIT_CREDIT" | "AMOUNT_DIRECTION";
export type DateFormat = "DMY" | "YMD" | "MDY";

export interface CsvParseOptions {
  separator?: string;
  dateFormat?: DateFormat;
  /** Force le séparateur décimal quand le fichier est ambigu (« 1,500 »). */
  decimalSeparator?: "," | ".";
  /** Correspondance explicite : nom d'en-tête ou index de colonne (base 0). */
  columns?: Partial<Record<CsvColumnKey, string | number>>;
  /** false : aucun en-tête, `columns` doit donner des index. */
  hasHeader?: boolean;
  /** true : les colonnes débit/crédit sont du point de vue de la banque (débit = encaissement). Défaut : point de vue de l'entreprise. */
  bankPerspective?: boolean;
}

export interface CsvParseError {
  line: number;
  message: string;
}

export interface CsvParseResult {
  rows: StatementRow[];
  errors: CsvParseError[];
  detected: {
    separator: string;
    layout: CsvLayout | null;
    headerLine: number | null;
    columns: Partial<Record<CsvColumnKey, number>>;
  };
}

const SYNONYMS: Array<[CsvColumnKey, string[]]> = [
  ["valueDate", ["date valeur", "date de valeur", "value date", "valeur", "date val"]],
  ["date", ["date", "date operation", "date d operation", "date de l operation", "date op", "transaction date", "date transaction", "date comptable", "booking date", "date de transaction", "jour"]],
  ["debit", ["debit", "retrait", "sortie", "sorties", "withdrawal", "withdrawals", "dr", "montant debit", "paid out", "decaissement", "decaissements", "money out"]],
  ["credit", ["credit", "depot", "entree", "entrees", "deposit", "deposits", "cr", "montant credit", "paid in", "encaissement", "encaissements", "money in"]],
  ["amount", ["montant", "amount", "montant signe", "somme", "montant xof", "montant fcfa", "valeur montant"]],
  ["externalId", ["id", "transaction id", "external id", "identifiant", "txid", "tx id", "id transaction", "id operation", "uid", "trans id", "transaction reference"]],
  ["reference", ["reference", "ref", "numero", "no", "n", "piece", "numero piece", "reference operation", "cheque", "num", "numero de piece", "ref operation"]],
  ["label", ["libelle", "libelle operation", "libelle de l operation", "label", "description", "intitule", "motif", "details", "detail", "narration", "objet", "designation", "memo", "operation", "transaction", "nature operation", "wording"]],
  ["direction", ["sens", "d c", "dc", "debit credit", "direction", "type operation", "type", "nature", "sens operation"]],
];

const OUT_DIRECTIONS = new Set(["d", "db", "dr", "debit", "-", "sortie", "retrait", "out", "withdrawal", "paiement", "payment", "decaissement"]);
const IN_DIRECTIONS = new Set(["c", "cr", "credit", "+", "entree", "depot", "in", "deposit", "encaissement", "versement", "recette"]);

/** Minuscule, sans accents (marques combinantes retirées), sans ponctuation ; mots séparés par une espace. */
export function normalizeHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Découpe une ligne CSV en champs, en respectant les guillemets doubles. */
export function splitCsvLine(line: string, separator: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** Choisit le séparateur le plus fréquent hors guillemets ; `;` gagne en cas d'égalité (décimales à virgule). */
export function detectSeparator(line: string): string {
  const candidates = [";", "\t", "|", ","];
  let best = ";";
  let bestCount = -1;
  for (const sep of candidates) {
    let count = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === sep) count++;
    }
    if (count > bestCount) {
      best = sep;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Lit un montant dans un format bancaire courant. Renvoie null si illisible.
 * Ambiguïté « 1,500 » / « 1.500 » : un seul séparateur suivi d'exactement
 * trois chiffres est traité comme séparateur de milliers (format XOF/anglais),
 * sauf si `decimalSeparator` est imposé.
 */
export function parseAmount(text: string, decimalSeparator?: "," | "."): Money | null {
  let s = text.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // \s couvre les espaces insécables (fine ou non) des formats français ; l'apostrophe sépare les milliers en Suisse.
  s = s.replace(/[\s']/g, "").replace(/[A-Za-z€$£]/g, "");
  if (s.startsWith("-") || s.endsWith("-")) negative = true;
  s = s.replace(/[+-]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalSep: "," | "." | null;
  if (decimalSeparator) decimalSep = decimalSeparator;
  else if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? "," : ".";
  else if (lastComma >= 0) decimalSep = looksLikeThousands(s, ",") ? null : ",";
  else if (lastDot >= 0) decimalSep = looksLikeThousands(s, ".") ? null : ".";
  else decimalSep = null;
  if (decimalSep) {
    const other = decimalSep === "," ? "." : ",";
    s = s.split(other).join("");
    const idx = s.lastIndexOf(decimalSep);
    if (idx >= 0) s = s.slice(0, idx).split(decimalSep).join("") + "." + s.slice(idx + 1);
  } else {
    s = s.replace(/[.,]/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return Money.parse(negative ? `-${s}` : s);
  } catch {
    return null;
  }
}

function looksLikeThousands(s: string, sep: string): boolean {
  const parts = s.split(sep);
  if (parts.length > 2) return parts.slice(1).every((p) => p.length === 3);
  return parts[1]?.length === 3;
}

/** Lit une date dans les formats courants ; renvoie une date ISO ou null. */
export function parseDate(text: string, format?: DateFormat): string | null {
  const s = text.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s].*)?$/.exec(s);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (ymd) {
    y = Number(ymd[1]);
    m = Number(ymd[2]);
    d = Number(ymd[3]);
  } else if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    y = Number(dmy[3]);
    if (dmy[3]!.length === 2) y += 2000;
    const monthFirst = format === "MDY" && a <= 12;
    d = monthFirst ? b : a;
    m = monthFirst ? a : b;
    if (format !== "MDY" && m > 12 && d <= 12) [d, m] = [m, d]; // fichier MDY non annoncé
  } else if (compact) {
    y = Number(compact[1]);
    m = Number(compact[2]);
    d = Number(compact[3]);
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function hasPhrase(words: string[], phrase: string): boolean {
  const p = phrase.split(" ");
  outer: for (let i = 0; i + p.length <= words.length; i++) {
    for (let j = 0; j < p.length; j++) if (words[i + j] !== p[j]) continue outer;
    return true;
  }
  return false;
}

/** Associe chaque en-tête à une clé de colonne (exact d'abord, puis par mots contenus). */
export function mapHeaders(headers: string[]): Partial<Record<CsvColumnKey, number>> {
  const cols: Partial<Record<CsvColumnKey, number>> = {};
  const normalized = headers.map(normalizeHeader);
  const taken = new Set<number>();
  for (const [key, syns] of SYNONYMS) {
    const idx = normalized.findIndex((h, i) => !taken.has(i) && syns.includes(h));
    if (idx >= 0) {
      cols[key] = idx;
      taken.add(idx);
    }
  }
  for (const [key, syns] of SYNONYMS) {
    if (cols[key] !== undefined) continue;
    const idx = normalized.findIndex((h, i) => {
      if (taken.has(i)) return false;
      const words = h.split(" ");
      return syns.some((s) => hasPhrase(words, s));
    });
    if (idx >= 0) {
      cols[key] = idx;
      taken.add(idx);
    }
  }
  return cols;
}

function isUsableHeader(cols: Partial<Record<CsvColumnKey, number>>): boolean {
  return cols.date !== undefined && (cols.amount !== undefined || cols.debit !== undefined || cols.credit !== undefined);
}

/** Retire une marque d'ordre d'octets (BOM) en tête de fichier, fréquente dans les exports Excel. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse un relevé CSV complet. Les lignes illisibles sont rapportées, jamais devinées. */
export function parseStatementCsv(text: string, opts: CsvParseOptions = {}): CsvParseResult {
  const lines = stripBom(text).split(/\r?\n/);
  const errors: CsvParseError[] = [];
  const rows: StatementRow[] = [];
  const firstContent = lines.find((l) => l.trim().length > 0) ?? "";
  let separator = opts.separator ?? detectSeparator(firstContent);

  let cols: Partial<Record<CsvColumnKey, number>> = {};
  let headerLine: number | null = null;
  let start = 0;
  if (opts.hasHeader === false) {
    cols = indexColumns(opts.columns ?? {}, []);
  } else {
    // Cherche la ligne d'en-tête parmi les 20 premières lignes non vides (préambule des banques) ;
    // le séparateur est détecté sur la ligne candidate, pas sur le préambule.
    let seen = 0;
    for (let i = 0; i < lines.length && seen < 20; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      seen++;
      const candidateSep = opts.separator ?? detectSeparator(line);
      const headers = splitCsvLine(line, candidateSep);
      const mapped = { ...mapHeaders(headers), ...indexColumns(opts.columns ?? {}, headers) };
      if (isUsableHeader(mapped)) {
        cols = mapped;
        separator = candidateSep;
        headerLine = i + 1;
        start = i + 1;
        break;
      }
    }
    if (headerLine === null) {
      return { rows, errors: [{ line: 0, message: "En-tête introuvable : aucune colonne date + montant (ou débit/crédit) reconnue" }], detected: { separator, layout: null, headerLine: null, columns: {} } };
    }
  }

  const layout: CsvLayout | null =
    cols.amount !== undefined ? (cols.direction !== undefined ? "AMOUNT_DIRECTION" : "SIGNED") : cols.debit !== undefined || cols.credit !== undefined ? "DEBIT_CREDIT" : null;
  if (!layout || cols.date === undefined) {
    return { rows, errors: [{ line: headerLine ?? 0, message: "Colonnes date et montant (ou débit/crédit) requises" }], detected: { separator, layout, headerLine, columns: cols } };
  }

  // La colonne « sens » n'est honorée que si ses valeurs ressemblent à D/C.
  let useDirection = layout === "AMOUNT_DIRECTION";
  if (useDirection) {
    const sample = lines
      .slice(start, start + 20)
      .filter((l) => l.trim())
      .map((l) => normalizeHeader(splitCsvLine(l, separator)[cols.direction!] ?? ""));
    useDirection = sample.length > 0 && sample.every((v) => OUT_DIRECTIONS.has(v) || IN_DIRECTIONS.has(v));
  }
  const effectiveLayout: CsvLayout = layout === "AMOUNT_DIRECTION" && !useDirection ? "SIGNED" : layout;

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const lineNo = i + 1;
    const fields = splitCsvLine(raw, separator);
    if (fields.every((f) => f === "")) continue;
    const at = (k: CsvColumnKey): string => (cols[k] === undefined ? "" : (fields[cols[k]!] ?? ""));

    const date = parseDate(at("date"), opts.dateFormat);
    if (!date) {
      errors.push({ line: lineNo, message: `Date illisible : « ${at("date")} »` });
      continue;
    }
    let amount: Money | null = null;
    if (effectiveLayout === "DEBIT_CREDIT") {
      const debitText = at("debit");
      const creditText = at("credit");
      const debit = debitText ? parseAmount(debitText, opts.decimalSeparator) : Money.zero();
      const credit = creditText ? parseAmount(creditText, opts.decimalSeparator) : Money.zero();
      if (!debit || !credit) {
        errors.push({ line: lineNo, message: `Montant illisible : débit « ${debitText} », crédit « ${creditText} »` });
        continue;
      }
      // Point de vue entreprise : crédit = encaissement. Point de vue banque : inversé.
      amount = opts.bankPerspective ? debit.abs().sub(credit.abs()) : credit.abs().sub(debit.abs());
    } else {
      const parsed = parseAmount(at("amount"), opts.decimalSeparator);
      if (!parsed) {
        errors.push({ line: lineNo, message: `Montant illisible : « ${at("amount")} »` });
        continue;
      }
      amount = parsed;
      if (effectiveLayout === "AMOUNT_DIRECTION") {
        const dir = normalizeHeader(at("direction"));
        amount = OUT_DIRECTIONS.has(dir) ? parsed.abs().neg() : parsed.abs();
      }
    }
    if (amount.isZero()) {
      errors.push({ line: lineNo, message: "Montant nul ignoré" });
      continue;
    }
    const valueDate = at("valueDate") ? parseDate(at("valueDate"), opts.dateFormat) : null;
    const label = at("label") || "(sans libellé)";
    const reference = at("reference");
    const externalId = at("externalId");
    rows.push({
      date,
      label,
      amount: amount.toString(),
      ...(valueDate ? { valueDate } : {}),
      ...(reference ? { reference } : {}),
      ...(externalId ? { externalId } : {}),
    });
  }
  return { rows, errors, detected: { separator, layout: effectiveLayout, headerLine, columns: cols } };
}

/** Résout une correspondance explicite (nom d'en-tête ou index) en index de colonnes. */
function indexColumns(columns: Partial<Record<CsvColumnKey, string | number>>, headers: string[]): Partial<Record<CsvColumnKey, number>> {
  const out: Partial<Record<CsvColumnKey, number>> = {};
  const normalized = headers.map(normalizeHeader);
  for (const [key, value] of Object.entries(columns) as Array<[CsvColumnKey, string | number | undefined]>) {
    if (value === undefined) continue;
    if (typeof value === "number") out[key] = value;
    else {
      const idx = normalized.indexOf(normalizeHeader(value));
      if (idx >= 0) out[key] = idx;
    }
  }
  return out;
}
