// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { normalizeCurrency, type CurrencyResolver } from "./currency.js";
import { LedgerError } from "./errors.js";
import { computeEntryHash } from "./hash.js";
import { Money, sum } from "./money.js";
import type { RateProvider } from "./rates.js";
import type { LedgerStore } from "./store.js";
import type {
  AccountBalance,
  Actor,
  Id,
  JournalEntry,
  JournalEntryInput,
  JournalLine,
  Period,
  TrialBalance,
} from "./types.js";
import { assertNoIssues, normalizeAndValidate } from "./validate.js";

export interface LedgerOptions {
  /**
   * Devise de repli, utilisée uniquement pour un dossier dont la devise est
   * inconnue du résolveur (dossier sans colonne `currency` renseignée, ou
   * moteur construit sans résolveur : tests, calculs hors ligne).
   */
  baseCurrency: string;
  /**
   * Devise de tenue par dossier. C'est elle qui fait foi : un dossier
   * camerounais en XAF ne doit pas hériter du XOF configuré sur le processus.
   * Le résolveur porte son propre cache et se partage entre requêtes.
   */
  currencyResolver?: CurrencyResolver;
  /** Table des taux de change, pour convertir les lignes en devise étrangère. */
  rates?: RateProvider;
  now?: () => Date;
}

/**
 * Moteur comptable : seule porte d'entrée pour écrire dans le grand livre.
 *
 * Cycle de vie d'une écriture : DRAFT → VALIDATED. Une écriture validée est
 * immuable ; la correction passe par `reverse()`, qui crée une écriture liée
 * de sens inverse.
 */
export class Ledger {
  private readonly now: () => Date;
  private readonly fallbackCurrency: string;

  constructor(
    private readonly store: LedgerStore,
    private readonly options: LedgerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.fallbackCurrency = normalizeCurrency(options.baseCurrency);
  }

  /**
   * Devise de tenue du dossier. La colonne `currency` de `company` l'emporte ;
   * la devise configurée sur le processus ne sert que de repli pour un dossier
   * qui n'en déclare aucune.
   */
  async baseCurrency(tenantId: Id): Promise<string> {
    const resolved = await this.options.currencyResolver?.currencyFor(tenantId);
    return resolved ?? this.fallbackCurrency;
  }

  /** Crée un brouillon après validation des invariants applicatifs. */
  async createDraft(actor: Actor, input: JournalEntryInput): Promise<JournalEntry> {
    if (input.clientId) {
      const existing = await this.store.findEntryByClientId(actor.tenantId, input.clientId);
      if (existing) return existing; // idempotence pour la synchronisation hors ligne
    }
    const journal = await this.store.getJournalByCode(actor.tenantId, input.journalCode);
    if (!journal) throw new LedgerError("UNKNOWN_JOURNAL", `Journal ${input.journalCode} inconnu`);

    const baseCurrency = await this.baseCurrency(actor.tenantId);
    const { lines, issues } = await normalizeAndValidate(this.store, actor.tenantId, input, {
      baseCurrency,
      ...(this.options.rates ? { rates: this.options.rates } : {}),
    });
    assertNoIssues(issues);

    const found = await this.store.findPeriodForDate(actor.tenantId, input.date);
    if (!found) throw new LedgerError("NO_OPEN_PERIOD", `Aucune période pour la date ${input.date}`);
    if (found.period.status !== "OPEN") {
      throw new LedgerError("PERIOD_LOCKED", `Période ${found.period.startDate} → ${found.period.endDate} ${labelStatus(found.period.status)}`);
    }

    const id = randomUUID();
    const entry: JournalEntry = {
      id,
      tenantId: actor.tenantId,
      journalId: journal.id,
      journalCode: journal.code,
      periodId: found.period.id,
      fiscalYearId: found.fiscalYear.id,
      number: null,
      date: input.date,
      reference: input.reference ?? null,
      label: input.label,
      status: "DRAFT",
      source: input.source,
      reversesEntryId: null,
      reversedByEntryId: null,
      prevHash: null,
      hash: null,
      createdBy: actor.userId,
      createdAt: this.now().toISOString(),
      validatedBy: null,
      validatedAt: null,
      lines: lines.map<JournalLine>((l) => ({
        id: randomUUID(),
        entryId: id,
        lineNo: l.lineNo,
        accountId: l.account.id,
        accountNumber: l.account.number,
        partnerId: l.partnerId,
        label: l.label,
        debit: l.debit,
        credit: l.credit,
        currency: l.currency,
        rate: l.rate,
        rateSource: l.rateSource,
        debitBase: l.debitBase,
        creditBase: l.creditBase,
        analyticCode: l.analyticCode,
        vatCode: l.vatCode,
      })),
    };
    const saved = await this.store.insertDraft(entry, input.clientId);
    await this.store.appendAudit({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "entry.draft",
      entity: "journal_entry",
      entityId: id,
      after: summarize(saved),
      at: entry.createdAt,
    });
    return saved;
  }

  /** Valide un brouillon : numérotation continue, chaînage, immutabilité. */
  async validate(actor: Actor, entryId: Id): Promise<JournalEntry> {
    const entry = await this.store.getEntry(actor.tenantId, entryId);
    if (!entry) throw new LedgerError("ENTRY_NOT_FOUND", `Écriture ${entryId} introuvable`);
    if (entry.status !== "DRAFT") throw new LedgerError("ENTRY_IMMUTABLE", "Écriture déjà validée");
    const found = await this.store.findPeriodForDate(actor.tenantId, entry.date);
    if (!found || found.period.status !== "OPEN") {
      throw new LedgerError("PERIOD_LOCKED", `Période de la date ${entry.date} clôturée ou verrouillée`);
    }
    const last = await this.store.lastValidated(actor.tenantId, entry.journalId);
    const number = (last?.number ?? 0) + 1;
    const prevHash = last?.hash ?? null;
    const withNumber: JournalEntry = { ...entry, number };
    const hash = computeEntryHash(withNumber, prevHash);
    const validatedAt = this.now().toISOString();
    const saved = await this.store.markValidated(withNumber, {
      number,
      prevHash,
      hash,
      validatedBy: actor.userId,
      validatedAt,
    });
    await this.store.appendAudit({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "entry.validate",
      entity: "journal_entry",
      entityId: entryId,
      after: { number, hash },
      at: validatedAt,
    });
    return saved;
  }

  /** Raccourci : brouillon + validation dans la foulée (import, écritures automatiques). */
  async post(actor: Actor, input: JournalEntryInput): Promise<JournalEntry> {
    const draft = await this.createDraft(actor, input);
    if (draft.status === "VALIDATED") return draft;
    return this.validate(actor, draft.id);
  }

  async discardDraft(actor: Actor, entryId: Id): Promise<void> {
    await this.store.deleteDraft(actor.tenantId, entryId);
    await this.store.appendAudit({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "entry.discard",
      entity: "journal_entry",
      entityId: entryId,
      at: this.now().toISOString(),
    });
  }

  /**
   * Contrepassation : crée et valide une écriture de sens inverse, datée du
   * jour demandé (par défaut la date d'origine), liée à l'écriture d'origine.
   */
  async reverse(actor: Actor, entryId: Id, opts: { date?: string; label?: string } = {}): Promise<JournalEntry> {
    const original = await this.store.getEntry(actor.tenantId, entryId);
    if (!original) throw new LedgerError("ENTRY_NOT_FOUND", `Écriture ${entryId} introuvable`);
    if (original.status !== "VALIDATED") throw new LedgerError("NOT_VALIDATED", "Seule une écriture validée se contrepasse ; supprimez le brouillon");
    if (original.reversedByEntryId) throw new LedgerError("ALREADY_REVERSED", "Écriture déjà contrepassée");

    const draft = await this.createDraft(actor, {
      journalCode: original.journalCode,
      date: opts.date ?? original.date,
      ...(original.reference ? { reference: original.reference } : {}),
      label: opts.label ?? `Contrepassation de ${original.journalCode} n°${original.number} : ${original.label}`,
      source: "REVERSAL",
      lines: original.lines.map((l) => ({
        accountNumber: l.accountNumber,
        debit: l.credit,
        credit: l.debit,
        label: l.label,
        currency: l.currency,
        ...(l.partnerId ? { partnerId: l.partnerId } : {}),
        // Une contrepassation reprend le taux d'origine : elle annule
        // l'écriture, elle ne constate pas un nouvel écart de change.
        ...(l.rate ? { rate: l.rate } : {}),
        ...(l.rateSource ? { rateSource: l.rateSource } : {}),
        ...(l.analyticCode ? { analyticCode: l.analyticCode } : {}),
        ...(l.vatCode ? { vatCode: l.vatCode } : {}),
      })),
    });
    // Marque le lien avant validation pour que le hash le couvre.
    const linked: JournalEntry = { ...draft, reversesEntryId: original.id };
    await this.store.insertDraft(linked);
    const validated = await this.validate(actor, linked.id);
    await this.store.linkReversal(actor.tenantId, original.id, validated.id);
    return validated;
  }

  /** Balance générale sur un exercice ou un intervalle de dates. */
  async trialBalance(tenantId: Id, opts: { fiscalYearCode: string; from?: string; to?: string }): Promise<TrialBalance> {
    const fy = await this.store.getFiscalYearByCode(tenantId, opts.fiscalYearCode);
    if (!fy) throw new LedgerError("NO_OPEN_PERIOD", `Exercice ${opts.fiscalYearCode} introuvable`);
    const from = opts.from ?? fy.startDate;
    const to = opts.to ?? fy.endDate;
    const rows = await this.store.accountBalances(tenantId, from, to);
    return {
      tenantId,
      currency: await this.baseCurrency(tenantId),
      fiscalYearCode: fy.code,
      from,
      to,
      rows,
      totalDebit: sum(rows.map((r) => r.debit)),
      totalCredit: sum(rows.map((r) => r.credit)),
    };
  }

  /**
   * Positions en devise étrangère par compte × tiers × devise : montants
   * d'origine et contrevaleurs historiques. Entrée de la retranslation de fin
   * de période (voir `planRetranslation`).
   */
  async foreignPositions(tenantId: Id, opts: { from: string; to: string; accountPrefixes?: string[] }) {
    return this.store.foreignPositions(tenantId, opts.from, opts.to, opts.accountPrefixes ? { accountPrefixes: opts.accountPrefixes } : {});
  }

  /** Écritures validées d'un exercice (grand livre), éventuellement limitées à un compte ou préfixe de compte. */
  async listEntries(tenantId: Id, opts: { fiscalYearCode: string; accountNumber?: string }): Promise<JournalEntry[]> {
    return this.store.listEntries(tenantId, opts);
  }

  /** Exercices du dossier (le plus ancien en premier). */
  listFiscalYears(tenantId: Id) {
    return this.store.listFiscalYears(tenantId);
  }

  /** Vérifie l'intégrité de la chaîne de hash d'un journal. */
  async verifyChain(tenantId: Id, journalCode: string): Promise<{ ok: boolean; brokenAt?: Id; checked: number }> {
    const journal = await this.store.getJournalByCode(tenantId, journalCode);
    if (!journal) throw new LedgerError("UNKNOWN_JOURNAL", `Journal ${journalCode} inconnu`);
    const entries = await this.store.listValidatedEntries(tenantId, journal.id);
    let prev: string | null = null;
    let expectedNumber = 1;
    for (const e of entries) {
      const expected = computeEntryHash(e, prev);
      if (e.hash !== expected || e.prevHash !== prev || e.number !== expectedNumber) {
        return { ok: false, brokenAt: e.id, checked: entries.length };
      }
      prev = e.hash;
      expectedNumber += 1;
    }
    return { ok: true, checked: entries.length };
  }

  async closePeriod(actor: Actor, period: Period, status: "CLOSED" | "LOCKED"): Promise<void> {
    await this.store.setPeriodStatus(actor.tenantId, period.id, status, actor);
    await this.store.appendAudit({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: `period.${status.toLowerCase()}`,
      entity: "period",
      entityId: period.id,
      before: { status: period.status },
      after: { status },
      at: this.now().toISOString(),
    });
  }
}

export function soldeOf(row: AccountBalance): { side: "D" | "C"; amount: Money } {
  const diff = row.debit.sub(row.credit);
  return diff.isNegative() ? { side: "C", amount: diff.neg() } : { side: "D", amount: diff };
}

function labelStatus(s: Period["status"]): string {
  return s === "CLOSED" ? "clôturée" : s === "LOCKED" ? "verrouillée" : "ouverte";
}

function summarize(e: JournalEntry) {
  return {
    journal: e.journalCode,
    date: e.date,
    label: e.label,
    lines: e.lines.map((l) => ({ account: l.accountNumber, d: l.debit.toString(), c: l.credit.toString() })),
  };
}
