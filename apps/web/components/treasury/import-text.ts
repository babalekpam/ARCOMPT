/**
 * Aides pures pour l'import de relevés : détection du type de texte (CSV ou
 * lot de SMS mobile money) et construction de la requête d'import.
 */
export type ImportKind = "CSV" | "SMS";

/** Devine si un texte est un CSV (lignes régulières séparées par ; , ou tab) ou une liste de SMS. */
export function detectImportKind(text: string): ImportKind {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (lines.length === 0) return "CSV";
  for (const sep of [";", "\t", ","]) {
    const counts = lines.map((l) => l.split(sep).length - 1);
    const first = counts[0] ?? 0;
    if (first >= 2 && counts.every((c) => c === first)) return "CSV";
  }
  // Un SMS contient typiquement un montant suivi d'une devise ou d'un mot-clé opérateur.
  const smsHints = /(XOF|FCFA|CFA|XAF|GNF|MTN|Orange|Wave|Moov|MoMo|reçu|recu|envoy|transf|retrait|d[ée]p[ôo]t)/i;
  if (lines.some((l) => smsHints.test(l))) return "SMS";
  return "CSV";
}

export interface ImportRequest {
  path: string;
  contentType: "text/csv" | "application/json";
  body: string;
  query: Record<string, string | undefined>;
}

export interface ImportFormValues {
  kind: ImportKind;
  text: string;
  periodFrom?: string;
  periodTo?: string;
  openingBalance?: string;
  closingBalance?: string;
  dateFormat?: "DMY" | "YMD" | "MDY";
  separator?: string;
  decimalSeparator?: "," | ".";
  hasHeader?: boolean;
  bankPerspective?: boolean;
  defaultDate?: string;
  includeFees?: boolean;
}

const clean = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);

/**
 * Corps de `POST /v1/treasury/accounts/:id/statements` :
 * - CSV sans option de colonne → texte brut `text/csv`, options de période en requête ;
 * - CSV avec options de parseur, ou SMS → JSON.
 */
export function buildImportRequest(accountId: string, v: ImportFormValues): ImportRequest {
  const path = `/treasury/accounts/${accountId}/statements`;
  const period = { periodFrom: clean(v.periodFrom), periodTo: clean(v.periodTo), openingBalance: clean(v.openingBalance), closingBalance: clean(v.closingBalance) };
  const csvOptions: Record<string, unknown> = {};
  if (v.dateFormat) csvOptions.dateFormat = v.dateFormat;
  if (clean(v.separator)) csvOptions.separator = v.separator;
  if (v.decimalSeparator) csvOptions.decimalSeparator = v.decimalSeparator;
  if (v.hasHeader === false) csvOptions.hasHeader = false;
  if (v.bankPerspective) csvOptions.bankPerspective = true;
  if (v.kind === "CSV" && Object.keys(csvOptions).length === 0) {
    return { path, contentType: "text/csv", body: v.text, query: { ...period, source: "CSV" } };
  }
  const json: Record<string, unknown> = { ...Object.fromEntries(Object.entries(period).filter(([, x]) => x !== undefined)) };
  if (v.kind === "CSV") {
    json.csv = v.text;
    json.csvOptions = csvOptions;
    json.source = "CSV";
  } else {
    json.sms = v.text;
    json.source = "SMS";
    const smsOptions: Record<string, unknown> = {};
    if (clean(v.defaultDate)) smsOptions.defaultDate = v.defaultDate;
    if (v.includeFees === false) smsOptions.includeFees = false;
    if (Object.keys(smsOptions).length > 0) json.smsOptions = smsOptions;
  }
  return { path, contentType: "application/json", body: JSON.stringify(json), query: {} };
}
