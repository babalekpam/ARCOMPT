import { Money } from "@arcompt/ledger";
import { parseAmount, parseDate } from "./csv.js";
import type { StatementRow } from "./types.js";

/**
 * Lecture des SMS mobile money (Orange Money, MTN MoMo, Wave, Moov…) par
 * expressions régulières simples. Formats visés :
 *   « Vous avez reçu 25 000 FCFA de KOUAME YAO (0707070707). Ref: PP250915.1432.A12345. Nouveau solde: 125 000 FCFA. »
 *   « Vous avez envoyé 10 000 FCFA à 0505050505 AKISSI. Frais: 100 FCFA. Ref: … »
 *   « You have received 25,000 FCFA from … Transaction Id: 1234567890. »
 *   « Retrait de 20 000 FCFA effectué le 15/09/2025 … »
 * Tout SMS qui ne livre pas un sens et un montant est renvoyé null : on ne devine pas.
 */
export interface MobileMoneySms {
  direction: "IN" | "OUT";
  /** Montant principal, signé (encaissement positif). */
  amount: string;
  /** Frais de l'opérateur, positifs, s'ils figurent dans le SMS. */
  fee?: string;
  date?: string;
  counterparty?: string;
  reference?: string;
  /** Nouveau solde annoncé par l'opérateur. */
  balance?: string;
  raw: string;
}

const IN_WORDS = ["recu", "received", "depot", "deposit", "credite", "credited", "encaisse", "versement recu", "vous a envoye", "reçu"];
const OUT_WORDS = ["envoye", "sent", "paye", "paid", "paiement", "payment", "retrait", "withdrawal", "withdrew", "withdrawn", "retire", "transfere", "transferred", "achat", "purchase", "debite", "debited", "recharge", "reglement"];

const AMOUNT_RE = /(\d(?:[\d\s  .,']*\d)?)\s*(?:F\s?CFA|FCFA|XOF|XAF|GNF|CDF|CFA|F\b)/gi;
const REFERENCE_RE = /\b(?:r[eé]f(?:[eé]rence)?|transaction\s*id|id\s*(?:de\s*)?(?:la\s*)?transaction|txn?\s*id|trans\s*id|n[°o]\s*(?:de\s*)?transaction)\s*[:.=]?\s*#?\s*([A-Za-z0-9][A-Za-z0-9.\-_/]{2,})/i;
const COUNTERPARTY_RE =
  /^\s*(?:de la part de|de|du|from|à|a|to|vers|chez|au|pour|par)\s+(.+?)(?=\s*\(|\s*\.\s|\s*\.$|\s*,|\s+(?:le|on)\s+\d|\s+(?:ref|reference|transaction|txn|id|frais|fee|nouveau|new|solde|balance|votre|your|montant|effectu[eé]e?|avec|succ[eè]s|r[eé]ussi|completed|successfully)(?![a-zà-ÿ])|$)/i;

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function firstIndexOf(haystack: string, words: string[]): number {
  let best = -1;
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
    const m = re.exec(haystack);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

export function parseMobileMoneySms(text: string): MobileMoneySms | null {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const norm = normalize(raw);
  const inIdx = firstIndexOf(norm, IN_WORDS);
  const outIdx = firstIndexOf(norm, OUT_WORDS);
  if (inIdx < 0 && outIdx < 0) return null;
  const direction: "IN" | "OUT" = inIdx >= 0 && (outIdx < 0 || inIdx <= outIdx) ? "IN" : "OUT";

  let main: { amount: Money; end: number } | null = null;
  let fee: Money | undefined;
  let balance: Money | undefined;
  AMOUNT_RE.lastIndex = 0;
  for (let m = AMOUNT_RE.exec(raw); m; m = AMOUNT_RE.exec(raw)) {
    const value = parseAmount(m[1]!);
    if (!value || value.isZero()) continue;
    const before = norm.slice(Math.max(0, m.index - 30), m.index);
    if (/frais|fee|commission|cout|charge/.test(before)) {
      if (fee === undefined) fee = value.abs();
    } else if (/solde|balance/.test(before)) {
      if (balance === undefined) balance = value;
    } else if (!main) {
      main = { amount: value.abs(), end: m.index + m[0].length };
    }
  }
  if (!main) return null;

  const refMatch = REFERENCE_RE.exec(raw);
  const reference = refMatch?.[1]?.replace(/[.,]$/, "");
  const withoutRef = refMatch ? raw.replace(refMatch[0], " ") : raw;
  const dateMatch = /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/.exec(withoutRef);
  const date = dateMatch ? parseDate(dateMatch[1]!) : null;
  const cp = COUNTERPARTY_RE.exec(raw.slice(main.end));
  const counterparty = cp?.[1]?.trim().replace(/[.,;]+$/, "").slice(0, 80);

  return {
    direction,
    amount: (direction === "IN" ? main.amount : main.amount.neg()).toString(),
    ...(fee ? { fee: fee.toString() } : {}),
    ...(date ? { date } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(reference ? { reference } : {}),
    ...(balance ? { balance: balance.toString() } : {}),
    raw,
  };
}

export interface SmsBatchOptions {
  /** Date appliquée aux SMS sans date lisible ; sinon ils sont rapportés comme non lus. */
  defaultDate?: string;
  /** Importer les frais comme ligne séparée (défaut : true). */
  includeFees?: boolean;
}

/** Convertit un SMS lu en ligne(s) de relevé : opération principale, puis frais éventuels. */
export function smsToRows(sms: MobileMoneySms, opts: SmsBatchOptions = {}): StatementRow[] {
  const date = sms.date ?? opts.defaultDate;
  if (!date) return [];
  const who = sms.counterparty ? ` ${sms.direction === "IN" ? "de" : "à"} ${sms.counterparty}` : "";
  const rows: StatementRow[] = [
    {
      date,
      label: `${sms.direction === "IN" ? "Mobile money reçu" : "Mobile money envoyé"}${who}`,
      amount: sms.amount,
      ...(sms.reference ? { reference: sms.reference, externalId: sms.reference } : {}),
    },
  ];
  if (sms.fee && opts.includeFees !== false) {
    rows.push({
      date,
      label: `Frais mobile money${sms.reference ? ` (${sms.reference})` : ""}`,
      amount: Money.parse(sms.fee).neg().toString(),
      ...(sms.reference ? { reference: sms.reference, externalId: `${sms.reference}-FEE` } : {}),
    });
  }
  return rows;
}

/**
 * Lit un lot de SMS (séparés par des lignes vides, ou un SMS par ligne).
 * Les messages illisibles sont renvoyés tels quels, jamais importés.
 */
export function parseMobileMoneySmsBatch(text: string, opts: SmsBatchOptions = {}): { rows: StatementRow[]; unparsed: string[] } {
  const rows: StatementRow[] = [];
  const unparsed: string[] = [];
  const chunks = text
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const parsed = parseMobileMoneySms(chunk);
    const produced = parsed ? smsToRows(parsed, opts) : [];
    if (produced.length > 0) {
      rows.push(...produced);
      continue;
    }
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) {
      unparsed.push(chunk);
      continue;
    }
    for (const line of lines) {
      const p = parseMobileMoneySms(line);
      const r = p ? smsToRows(p, opts) : [];
      if (r.length > 0) rows.push(...r);
      else unparsed.push(line);
    }
  }
  return { rows, unparsed };
}
