// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { isCurrencyCode, normalizeCurrency } from "./currency.js";
import { EntryValidationError, type ValidationIssue } from "./errors.js";
import { Money } from "./money.js";
import { isUsableRate, type RateProvider } from "./rates.js";
import type { LedgerStore } from "./store.js";
import type { Account, Id, JournalEntryInput, JournalLineInput } from "./types.js";

export interface NormalizedLine {
  lineNo: number;
  account: Account;
  partnerId: Id | null;
  label: string;
  /** Montant d'origine, dans `currency`. */
  debit: Money;
  credit: Money;
  currency: string;
  /** Null si la ligne est déjà dans la devise du dossier. */
  rate: string | null;
  rateSource: string | null;
  /** Montant converti dans la devise du dossier. */
  debitBase: Money;
  creditBase: Money;
  analyticCode: string | null;
  vatCode: string | null;
}

export interface ValidateOptions {
  /** Devise de tenue du dossier, déjà résolue (colonne `currency` de `company`). */
  baseCurrency: string;
  /** Table des taux. Absente, seul un taux porté par la ligne est accepté. */
  rates?: RateProvider;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valide une écriture avant insertion. Les mêmes invariants existent en base
 * (triggers) : la validation applicative sert à produire des messages
 * utilisables et à travailler hors ligne.
 *
 * Multidevise : une ligne libellée dans une autre devise que celle du dossier
 * doit porter un taux — saisi sur la pièce, ou trouvé dans la table des taux à
 * la date de l'écriture. Sans taux utilisable, l'écriture est refusée ; elle
 * n'est jamais traitée comme si elle était déjà dans la devise du dossier.
 * L'équilibre se juge sur les montants convertis, jamais sur les montants
 * d'origine.
 */
export async function normalizeAndValidate(
  store: LedgerStore,
  tenantId: Id,
  input: JournalEntryInput,
  options: ValidateOptions,
): Promise<{ lines: NormalizedLine[]; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const lines: NormalizedLine[] = [];

  const dateValid = ISO_DATE.test(input.date) && !Number.isNaN(Date.parse(input.date));
  if (!dateValid) {
    issues.push({ code: "INVALID_DATE", message: `Date invalide : ${input.date}` });
  }
  if (!input.lines || input.lines.length < 2) {
    issues.push({ code: "EMPTY_ENTRY", message: "Une écriture comporte au moins deux lignes" });
  }

  let baseCurrency: string;
  try {
    baseCurrency = normalizeCurrency(options.baseCurrency);
  } catch (e) {
    issues.push({ code: "UNKNOWN_CURRENCY", message: `Devise du dossier : ${(e as Error).message}` });
    return { lines, issues };
  }

  let lineNo = 0;
  for (const raw of input.lines ?? []) {
    lineNo += 1;
    const n = await normalizeLine(store, tenantId, raw, lineNo, { baseCurrency, date: input.date, dateValid, ...(options.rates ? { rates: options.rates } : {}) }, issues);
    if (n) lines.push(n);
  }

  // Équilibre sur les montants convertis : un euro et un franc ne s'additionnent
  // qu'une fois ramenés à la devise du dossier.
  const totalDebit = lines.reduce((acc, l) => acc.add(l.debitBase), Money.zero());
  const totalCredit = lines.reduce((acc, l) => acc.add(l.creditBase), Money.zero());
  if (!totalDebit.eq(totalCredit)) {
    const multi = lines.some((l) => l.currency !== baseCurrency);
    issues.push({
      code: "UNBALANCED",
      message: multi
        ? `Écriture déséquilibrée en ${baseCurrency} après conversion : débits ${totalDebit} ≠ crédits ${totalCredit}`
        : `Écriture déséquilibrée : débits ${totalDebit} ≠ crédits ${totalCredit}`,
    });
  }
  if (lines.length > 0 && totalDebit.isZero() && totalCredit.isZero()) {
    issues.push({ code: "EMPTY_ENTRY", message: "Écriture sans montant" });
  }
  return { lines, issues };
}

interface LineContext {
  baseCurrency: string;
  date: string;
  dateValid: boolean;
  rates?: RateProvider;
}

async function normalizeLine(
  store: LedgerStore,
  tenantId: Id,
  raw: JournalLineInput,
  lineNo: number,
  ctx: LineContext,
  issues: ValidationIssue[],
): Promise<NormalizedLine | null> {
  let debit = Money.zero();
  let credit = Money.zero();
  try {
    if (raw.debit !== undefined) debit = Money.parse(raw.debit);
    if (raw.credit !== undefined) credit = Money.parse(raw.credit);
  } catch (e) {
    issues.push({ code: "LINE_NO_AMOUNT", message: `Ligne ${lineNo} : ${(e as Error).message}`, lineNo });
    return null;
  }
  if (!debit.isZero() && !credit.isZero()) {
    issues.push({ code: "LINE_BOTH_SIDES", message: `Ligne ${lineNo} : débit ou crédit, jamais les deux`, lineNo });
  }
  if (debit.isZero() && credit.isZero()) {
    issues.push({ code: "LINE_NO_AMOUNT", message: `Ligne ${lineNo} : montant nul`, lineNo });
  }
  if (debit.isNegative() || credit.isNegative()) {
    issues.push({ code: "LINE_NEGATIVE", message: `Ligne ${lineNo} : montant négatif ; inversez le sens`, lineNo });
  }
  const account = await store.getAccountByNumber(tenantId, raw.accountNumber);
  if (!account) {
    issues.push({ code: "UNKNOWN_ACCOUNT", message: `Ligne ${lineNo} : compte ${raw.accountNumber} absent du plan`, lineNo });
    return null;
  }
  if (!account.postable) {
    issues.push({ code: "ACCOUNT_NOT_POSTABLE", message: `Ligne ${lineNo} : compte ${account.number} non imputable (compte de regroupement)`, lineNo });
  }
  if (!account.active) {
    issues.push({ code: "ACCOUNT_INACTIVE", message: `Ligne ${lineNo} : compte ${account.number} désactivé`, lineNo });
  }
  if (account.lettrable && !raw.partnerId) {
    issues.push({ code: "PARTNER_REQUIRED", message: `Ligne ${lineNo} : le compte ${account.number} exige un tiers`, lineNo });
  }

  const conversion = await resolveConversion(tenantId, raw, lineNo, debit, credit, ctx, issues);
  if (!conversion) return null;

  return {
    lineNo,
    account,
    partnerId: raw.partnerId ?? null,
    label: raw.label ?? "",
    debit,
    credit,
    ...conversion,
    analyticCode: raw.analyticCode ?? null,
    vatCode: raw.vatCode ?? null,
  };
}

interface Conversion {
  currency: string;
  rate: string | null;
  rateSource: string | null;
  debitBase: Money;
  creditBase: Money;
}

async function resolveConversion(
  tenantId: Id,
  raw: JournalLineInput,
  lineNo: number,
  debit: Money,
  credit: Money,
  ctx: LineContext,
  issues: ValidationIssue[],
): Promise<Conversion | null> {
  const declared = raw.currency ?? ctx.baseCurrency;
  if (!isCurrencyCode(declared)) {
    issues.push({ code: "UNKNOWN_CURRENCY", message: `Ligne ${lineNo} : devise "${raw.currency}" invalide (code ISO 4217 attendu)`, lineNo });
    return null;
  }
  const currency = normalizeCurrency(declared);

  // Ligne déjà dans la devise du dossier : pas de taux, pas de conversion.
  if (currency === ctx.baseCurrency) {
    if (raw.rate !== undefined && raw.rate !== null && parseFloatSafe(raw.rate) !== 1) {
      issues.push({
        code: "RATE_NOT_APPLICABLE",
        message: `Ligne ${lineNo} : taux ${raw.rate} sur une ligne déjà en ${ctx.baseCurrency} ; retirez le taux ou changez la devise de la ligne`,
        lineNo,
      });
      return null;
    }
    return { currency, rate: null, rateSource: null, debitBase: debit, creditBase: credit };
  }

  // Devise étrangère : un taux est exigé. Saisi sur la pièce, il l'emporte
  // (c'est le cours réellement obtenu par l'entreprise) ; sinon on interroge la
  // table des taux à la date de l'écriture.
  let rate: string | null = null;
  let rateSource: string | null = null;
  if (raw.rate !== undefined && raw.rate !== null && String(raw.rate).trim() !== "") {
    if (!isUsableRate(raw.rate)) {
      issues.push({ code: "RATE_INVALID", message: `Ligne ${lineNo} : taux "${raw.rate}" invalide ; un taux est un nombre strictement positif à 10 décimales au plus`, lineNo });
      return null;
    }
    rate = String(raw.rate).trim();
    rateSource = raw.rateSource ?? "MANUAL";
  } else if (ctx.rates && ctx.dateValid) {
    const quote = await ctx.rates.getRate(tenantId, currency, ctx.baseCurrency, ctx.date);
    if (quote) {
      rate = quote.rate;
      rateSource = quote.inverted ? `${quote.source}/INVERSE` : quote.source;
    }
  }

  if (rate === null) {
    issues.push({
      code: "RATE_REQUIRED",
      message: `Ligne ${lineNo} : ligne en ${currency} sans taux vers ${ctx.baseCurrency}${ctx.dateValid ? ` au ${ctx.date}` : ""} ; saisissez le cours de la pièce ou alimentez la table des taux`,
      lineNo,
    });
    return null;
  }

  const debitBase = debit.mulRate(rate);
  const creditBase = credit.mulRate(rate);
  if ((!debit.isZero() && debitBase.isZero()) || (!credit.isZero() && creditBase.isZero())) {
    issues.push({
      code: "CONVERSION_UNDERFLOW",
      message: `Ligne ${lineNo} : le taux ${rate} ramène le montant à zéro en ${ctx.baseCurrency} ; montant ou taux à revoir`,
      lineNo,
    });
    return null;
  }
  return { currency, rate, rateSource, debitBase, creditBase };
}

/** Compare un taux saisi à 1 sans passer par un flottant approximatif. */
function parseFloatSafe(rate: string): number {
  const t = rate.trim().replace(",", ".");
  return /^0*1(\.0*)?$/.test(t) ? 1 : Number.NaN;
}

export function assertNoIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new EntryValidationError(issues);
}
