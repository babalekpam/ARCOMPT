// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { Money, sum, type Actor, type JournalEntry, type Ledger } from "@arcompt/ledger";
import { parseStatementCsv, type CsvParseError, type CsvParseOptions } from "./csv.js";
import { TreasuryError } from "./errors.js";
import { forecast13Weeks, type Forecast, type ForecastInputs } from "./forecast.js";
import type { LlmMatcher } from "./llm-matcher.js";
import { DEFAULT_MATCH_OPTIONS, matchTransactions, type MatchDecision, type MatchOptions } from "./matching.js";
import { findRule } from "./rules.js";
import { parseMobileMoneySmsBatch, type SmsBatchOptions } from "./sms.js";
import type {
  BankRule,
  BankRuleInput,
  BankStatement,
  BankTransaction,
  CashCount,
  Id,
  LedgerLineCandidate,
  MatchMethod,
  StatementRow,
  StatementSource,
  TransactionStatus,
  TreasuryAccount,
  TreasuryAccountInput,
  TreasuryAccountKind,
} from "./types.js";

/** Seuil plancher : même configuré, l'appariement automatique ne descend jamais en dessous. */
export const MIN_AUTO_MATCH_THRESHOLD = 0.75;

export interface TreasuryContext {
  tenantId: Id;
  userId: Id;
  organizationId?: Id;
}

export interface TreasuryServiceOptions {
  db: Sql;
  ledger: Ledger;
  ctx: TreasuryContext;
  /** Appariement assisté pour les libellés ambigus ; absent = jamais d'appel IA. */
  llmMatcher?: LlmMatcher;
  /** Seuil de confiance (défaut 0,9 ; plancher MIN_AUTO_MATCH_THRESHOLD). */
  matchThreshold?: number;
  dateWindowDays?: number;
  /** Écart de caisse (valeur absolue) à partir duquel un comptage est signalé comme anomalie (défaut : tout écart non nul). */
  cashAnomalyThreshold?: Money | string;
  /** Comptes d'écart de caisse (défaut 658 / 758). */
  cashDifferenceAccounts?: { shortage?: string; surplus?: string };
  now?: () => Date;
}

export type StatementImportInput = { rows: StatementRow[] } | { csv: string; csvOptions?: CsvParseOptions } | { sms: string; smsOptions?: SmsBatchOptions };

export interface StatementImportOptions {
  periodFrom?: string;
  periodTo?: string;
  openingBalance?: Money | string;
  closingBalance?: Money | string;
  source?: StatementSource;
  documentId?: Id;
}

export interface StatementImportResult {
  statement: BankStatement;
  imported: number;
  /** Lignes déjà présentes (identifiant externe ou date + montant + libellé). */
  skippedDuplicates: number;
  /** Lignes illisibles rapportées par le parseur. */
  parseErrors: CsvParseError[];
  /** SMS non reconnus. */
  unparsed: string[];
  /** Lignes datées dans une période clôturée ou verrouillée : importables, mais aucune écriture ne pourra y être créée. */
  rowsInClosedPeriods: number;
}

export interface AutoMatchResult {
  matched: number;
  unmatched: number;
  llmConsulted: number;
  decisions: Array<MatchDecision & { method?: MatchMethod; confidence?: number; suggestedRuleId?: Id; suggestedAccountNumber?: string }>;
}

export interface OutstandingItem {
  id: Id;
  date: string;
  label: string;
  amount: string;
}

export interface CashCountAnomaly {
  cashCountId: Id;
  countedOn: string;
  difference: string;
  note: string | null;
}

export interface ReconciliationReport {
  account: TreasuryAccount;
  asOf: string;
  /** Solde comptable du compte (débit − crédit) à la date. */
  bookBalance: string;
  /** Solde du dernier relevé clos à la date, ou null. */
  statementBalance: string | null;
  statementId: Id | null;
  /** Depuis quand on rapproche : début du premier relevé (les lignes antérieures sont couvertes par le solde d'ouverture). */
  reconciledFrom: string | null;
  /** Sur le relevé, pas encore en comptabilité. */
  unbookedTransactions: OutstandingItem[];
  /** En comptabilité, pas encore sur le relevé (chèques émis non débités, remises en cours…). */
  unclearedLines: OutstandingItem[];
  ignoredTransactions: number;
  adjustedBookBalance: string;
  adjustedStatementBalance: string | null;
  difference: string | null;
  balanced: boolean;
  /** Comptages de caisse dont l'écart dépasse le seuil (comptes CASH). */
  cashCountAnomalies: CashCountAnomaly[];
}

export interface CashCountInput {
  date: string;
  countedAmount: Money | string;
  note?: string;
  /** Comptabiliser l'écart (658 manquant / 758 excédent) ; défaut false. */
  postDifference?: boolean;
}

export interface CashCountResult {
  count: CashCount;
  entry: JournalEntry | null;
  negativeCash: boolean;
  anomaly: boolean;
  warnings: string[];
}

/**
 * Service trésorerie : comptes de trésorerie, relevés, rapprochement, caisse, prévision.
 * Toute lecture ou écriture SQL passe par withTenant() ; toute écriture au grand livre par Ledger.
 */
export class TreasuryService {
  private readonly now: () => Date;
  private readonly matchOpts: Required<MatchOptions>;
  private readonly cashThreshold: Money;

  constructor(private readonly opts: TreasuryServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    const threshold = Math.max(MIN_AUTO_MATCH_THRESHOLD, opts.matchThreshold ?? DEFAULT_MATCH_OPTIONS.threshold);
    this.matchOpts = { ...DEFAULT_MATCH_OPTIONS, threshold, dateWindowDays: opts.dateWindowDays ?? DEFAULT_MATCH_OPTIONS.dateWindowDays };
    this.cashThreshold = Money.parse(opts.cashAnomalyThreshold ?? "0").abs();
  }

  get ctx(): TreasuryContext {
    return this.opts.ctx;
  }

  private get actor(): Actor {
    return { userId: this.opts.ctx.userId, tenantId: this.opts.ctx.tenantId };
  }

  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.opts.db, this.opts.ctx, fn);
  }

  private async audit(tx: Sql, action: string, entity: string, entityId: Id, after?: unknown, before?: unknown): Promise<void> {
    await tx`
      INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
      VALUES (${this.opts.ctx.tenantId}, ${this.opts.ctx.userId}, ${action}, ${entity}, ${entityId},
              ${before === undefined ? null : tx.json(before as never)}, ${after === undefined ? null : tx.json(after as never)}, ${this.now().toISOString()})`;
  }

  // ---------------------------------------------------------------------------
  // Comptes de trésorerie
  // ---------------------------------------------------------------------------

  async listAccounts(opts: { includeInactive?: boolean } = {}): Promise<TreasuryAccount[]> {
    return this.tx(async (tx) => {
      const rows = opts.includeInactive
        ? await tx`SELECT * FROM treasury_account WHERE tenant_id = ${this.ctx.tenantId} ORDER BY kind, label`
        : await tx`SELECT * FROM treasury_account WHERE tenant_id = ${this.ctx.tenantId} AND active ORDER BY kind, label`;
      return rows.map(mapAccount);
    });
  }

  async getAccount(id: Id): Promise<TreasuryAccount> {
    return this.tx((tx) => this.loadAccount(tx, id));
  }

  private async loadAccount(tx: Sql, id: Id): Promise<TreasuryAccount> {
    const rows = await tx`SELECT * FROM treasury_account WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id}`;
    if (!rows[0]) throw new TreasuryError("ACCOUNT_NOT_FOUND", `Compte de trésorerie ${id} introuvable`);
    return mapAccount(rows[0]);
  }

  async createAccount(input: TreasuryAccountInput): Promise<TreasuryAccount> {
    return this.tx(async (tx) => {
      await this.assertChartAccount(tx, input.accountNumber);
      const [row] = await tx`
        INSERT INTO treasury_account (tenant_id, kind, label, account_number, currency, bank_name, iban, mm_operator, mm_phone, active)
        VALUES (${this.ctx.tenantId}, ${input.kind}, ${input.label}, ${input.accountNumber}, ${input.currency.toUpperCase()},
                ${input.bankName ?? null}, ${input.iban ?? null}, ${input.mmOperator ?? null}, ${input.mmPhone ?? null}, ${input.active ?? true})
        RETURNING *`;
      const account = mapAccount(row!);
      await this.audit(tx, "treasury.account.create", "treasury_account", account.id, account);
      return account;
    });
  }

  async updateAccount(id: Id, patch: Partial<TreasuryAccountInput>): Promise<TreasuryAccount> {
    return this.tx(async (tx) => {
      const before = await this.loadAccount(tx, id);
      if (patch.accountNumber && patch.accountNumber !== before.accountNumber) await this.assertChartAccount(tx, patch.accountNumber);
      const [row] = await tx`
        UPDATE treasury_account SET
          kind = ${patch.kind ?? before.kind}, label = ${patch.label ?? before.label}, account_number = ${patch.accountNumber ?? before.accountNumber},
          currency = ${(patch.currency ?? before.currency).toUpperCase()}, bank_name = ${patch.bankName === undefined ? before.bankName : patch.bankName},
          iban = ${patch.iban === undefined ? before.iban : patch.iban}, mm_operator = ${patch.mmOperator === undefined ? before.mmOperator : patch.mmOperator},
          mm_phone = ${patch.mmPhone === undefined ? before.mmPhone : patch.mmPhone}, active = ${patch.active ?? before.active}
        WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id} RETURNING *`;
      const after = mapAccount(row!);
      await this.audit(tx, "treasury.account.update", "treasury_account", id, after, before);
      return after;
    });
  }

  /** Supprime un compte sans historique ; sinon le désactive. */
  async deleteAccount(id: Id): Promise<{ deleted: boolean; account: TreasuryAccount | null }> {
    return this.tx(async (tx) => {
      const before = await this.loadAccount(tx, id);
      const [used] = await tx`
        SELECT (SELECT count(*) FROM bank_statement WHERE treasury_account_id = ${id})::int
             + (SELECT count(*) FROM cash_count WHERE treasury_account_id = ${id})::int AS n`;
      if (Number(used!.n) > 0) {
        const [row] = await tx`UPDATE treasury_account SET active = false WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id} RETURNING *`;
        await this.audit(tx, "treasury.account.deactivate", "treasury_account", id, { active: false }, before);
        return { deleted: false, account: mapAccount(row!) };
      }
      await tx`DELETE FROM treasury_account WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id}`;
      await this.audit(tx, "treasury.account.delete", "treasury_account", id, undefined, before);
      return { deleted: true, account: null };
    });
  }

  /** Le compte du plan doit exister, être imputable et de classe 5. */
  private async assertChartAccount(tx: Sql, number: string): Promise<void> {
    const rows = await tx`SELECT postable, active, class FROM account WHERE tenant_id = ${this.ctx.tenantId} AND number = ${number}`;
    const a = rows[0];
    if (!a || !a.postable || !a.active || Number(a.class) !== 5) {
      throw new TreasuryError("UNKNOWN_CHART_ACCOUNT", `Le compte ${number} doit exister dans le plan, être imputable, actif et de classe 5`);
    }
  }

  // ---------------------------------------------------------------------------
  // Relevés
  // ---------------------------------------------------------------------------

  async importStatement(accountId: Id, input: StatementImportInput, opts: StatementImportOptions = {}): Promise<StatementImportResult> {
    let rows: StatementRow[];
    let parseErrors: CsvParseError[] = [];
    let unparsed: string[] = [];
    let source: StatementSource = opts.source ?? "API";
    if ("csv" in input) {
      const parsed = parseStatementCsv(input.csv, input.csvOptions ?? {});
      rows = parsed.rows;
      parseErrors = parsed.errors;
      source = opts.source ?? "CSV";
      if (rows.length === 0 && parseErrors.length > 0) throw new TreasuryError("PARSE_ERROR", parseErrors[0]!.message, { errors: parseErrors });
    } else if ("sms" in input) {
      const parsed = parseMobileMoneySmsBatch(input.sms, input.smsOptions ?? {});
      rows = parsed.rows;
      unparsed = parsed.unparsed;
      source = opts.source ?? "SMS";
    } else {
      rows = input.rows;
    }
    // Normalisation stricte : un montant illisible ou nul est refusé, jamais deviné.
    const normalized = rows.map((r, i) => {
      let amount: Money;
      try {
        amount = Money.parse(r.amount);
      } catch {
        throw new TreasuryError("INVALID_INPUT", `Ligne ${i + 1} : montant invalide « ${r.amount} »`);
      }
      if (amount.isZero()) throw new TreasuryError("INVALID_INPUT", `Ligne ${i + 1} : montant nul`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new TreasuryError("INVALID_INPUT", `Ligne ${i + 1} : date invalide « ${r.date} »`);
      return { ...r, amount: amount.toString(), label: r.label.trim() || "(sans libellé)" };
    });
    if (normalized.length === 0) throw new TreasuryError("EMPTY_STATEMENT", "Aucune ligne à importer", { parseErrors, unparsed });

    const dates = normalized.map((r) => r.date).sort();
    const periodFrom = opts.periodFrom ?? dates[0]!;
    const periodTo = opts.periodTo ?? dates[dates.length - 1]!;
    if (periodTo < periodFrom) throw new TreasuryError("INVALID_INPUT", "periodTo doit être postérieure à periodFrom");
    const hash = statementHash(accountId, source, normalized);

    return this.tx(async (tx) => {
      const account = await this.loadAccount(tx, accountId);
      if (!account.active) throw new TreasuryError("ACCOUNT_INACTIVE", `Compte ${account.label} désactivé`);
      const dup = await tx`SELECT id FROM bank_statement WHERE tenant_id = ${this.ctx.tenantId} AND hash = ${hash}`;
      if (dup[0]) throw new TreasuryError("DUPLICATE_STATEMENT", "Ce relevé a déjà été importé", { statementId: dup[0].id });

      // Doublons ligne à ligne contre l'existant : identifiant externe, sinon (date, montant, libellé).
      const existing = await tx`
        SELECT tx_date::text AS d, amount::text AS a, label, external_id
          FROM bank_transaction WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} AND tx_date BETWEEN ${periodFrom} AND ${periodTo}`;
      const seenKeys = new Set(existing.map((r) => rowKey(r.d as string, r.a as string, r.label as string)));
      const seenExternal = new Set(existing.map((r) => r.external_id as string | null).filter((x): x is string => !!x));
      const fresh: StatementRow[] = [];
      let skipped = 0;
      for (const r of normalized) {
        const key = rowKey(r.date, r.amount, r.label);
        if ((r.externalId && seenExternal.has(r.externalId)) || seenKeys.has(key)) {
          skipped++;
          continue;
        }
        if (r.externalId) seenExternal.add(r.externalId);
        seenKeys.add(key);
        fresh.push(r);
      }
      // Toutes les lignes existent déjà : c'est un doublon, on ne crée pas de relevé vide.
      if (fresh.length === 0) throw new TreasuryError("DUPLICATE_STATEMENT", "Toutes les lignes de ce relevé ont déjà été importées", { skippedDuplicates: skipped });

      // Solde d'ouverture : donné, sinon clôture du dernier relevé terminé avant celui-ci (les lignes déjà
      // importées ayant été écartées, ouverture + lignes nouvelles donne bien la clôture).
      let opening = opts.openingBalance !== undefined ? Money.parse(opts.openingBalance) : null;
      if (opening === null) {
        const prev = await tx`
          SELECT closing_balance::text AS c FROM bank_statement
           WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} AND period_to < ${periodTo} AND closing_balance IS NOT NULL
           ORDER BY period_to DESC, imported_at DESC LIMIT 1`;
        if (prev[0]) opening = Money.parse(prev[0].c as string);
      }
      const movement = sum(fresh.map((r) => Money.parse(r.amount)));
      const closing = opts.closingBalance !== undefined ? Money.parse(opts.closingBalance) : opening ? opening.add(movement) : null;

      const [st] = await tx`
        INSERT INTO bank_statement (tenant_id, treasury_account_id, period_from, period_to, opening_balance, closing_balance, source, document_id, hash, imported_by, imported_at)
        VALUES (${this.ctx.tenantId}, ${accountId}, ${periodFrom}, ${periodTo}, ${opening ? opening.toString() : null}, ${closing ? closing.toString() : null},
                ${source}, ${opts.documentId ?? null}, ${hash}, ${this.ctx.userId}, ${this.now().toISOString()})
        RETURNING id, tenant_id, treasury_account_id, period_from::text AS period_from, period_to::text AS period_to, opening_balance::text AS opening_balance,
                  closing_balance::text AS closing_balance, source, document_id, hash, imported_by, imported_at`;
      const statement = mapStatement(st!);
      for (const r of fresh) {
        await tx`
          INSERT INTO bank_transaction (tenant_id, statement_id, treasury_account_id, tx_date, value_date, label, amount, reference, external_id)
          VALUES (${this.ctx.tenantId}, ${statement.id}, ${accountId}, ${r.date}, ${r.valueDate ?? null}, ${r.label}, ${r.amount}, ${r.reference ?? null}, ${r.externalId ?? null})`;
      }
      // Sécurité : une ligne datée dans une période close reste importable (c'est un fait bancaire),
      // mais aucune écriture ne pourra y être créée ; on le signale dès l'import.
      const [closed] = await tx`
        SELECT count(*)::int AS n FROM bank_transaction t
          JOIN period p ON p.tenant_id = t.tenant_id AND t.tx_date BETWEEN p.start_date AND p.end_date
         WHERE t.tenant_id = ${this.ctx.tenantId} AND t.statement_id = ${statement.id} AND p.status <> 'OPEN'`;
      await this.audit(tx, "treasury.statement.import", "bank_statement", statement.id, { accountId, source, periodFrom, periodTo, imported: fresh.length, skipped });
      return { statement, imported: fresh.length, skippedDuplicates: skipped, parseErrors, unparsed, rowsInClosedPeriods: Number(closed!.n) };
    });
  }

  async listStatements(accountId: Id): Promise<BankStatement[]> {
    return this.tx(async (tx) => {
      await this.loadAccount(tx, accountId);
      const rows = await tx`
        SELECT id, tenant_id, treasury_account_id, period_from::text AS period_from, period_to::text AS period_to, opening_balance::text AS opening_balance,
               closing_balance::text AS closing_balance, source, document_id, hash, imported_by, imported_at
          FROM bank_statement WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} ORDER BY period_from DESC, imported_at DESC`;
      return rows.map(mapStatement);
    });
  }

  async getStatement(id: Id): Promise<BankStatement> {
    return this.tx((tx) => this.loadStatement(tx, id));
  }

  private async loadStatement(tx: Sql, id: Id): Promise<BankStatement> {
    const rows = await tx`
      SELECT id, tenant_id, treasury_account_id, period_from::text AS period_from, period_to::text AS period_to, opening_balance::text AS opening_balance,
             closing_balance::text AS closing_balance, source, document_id, hash, imported_by, imported_at
        FROM bank_statement WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id}`;
    if (!rows[0]) throw new TreasuryError("STATEMENT_NOT_FOUND", `Relevé ${id} introuvable`);
    return mapStatement(rows[0]);
  }

  async listTransactions(statementId: Id, opts: { status?: TransactionStatus } = {}): Promise<BankTransaction[]> {
    return this.tx(async (tx) => {
      await this.loadStatement(tx, statementId);
      const rows = opts.status
        ? await tx`${txSelect(tx)} WHERE t.tenant_id = ${this.ctx.tenantId} AND t.statement_id = ${statementId} AND t.status = ${opts.status} ORDER BY t.tx_date, t.created_at`
        : await tx`${txSelect(tx)} WHERE t.tenant_id = ${this.ctx.tenantId} AND t.statement_id = ${statementId} ORDER BY t.tx_date, t.created_at`;
      return rows.map(mapTransaction);
    });
  }

  async getTransaction(id: Id): Promise<BankTransaction> {
    return this.tx((tx) => this.loadTransaction(tx, id));
  }

  private async loadTransaction(tx: Sql, id: Id): Promise<BankTransaction> {
    const rows = await tx`${txSelect(tx)} WHERE t.tenant_id = ${this.ctx.tenantId} AND t.id = ${id}`;
    if (!rows[0]) throw new TreasuryError("TRANSACTION_NOT_FOUND", `Ligne de relevé ${id} introuvable`);
    return mapTransaction(rows[0]);
  }

  // ---------------------------------------------------------------------------
  // Lignes du grand livre sur le compte de trésorerie
  // ---------------------------------------------------------------------------

  /** Lignes validées du compte, non encore rapprochées, dans un intervalle de dates. */
  private async unmatchedLines(tx: Sql, accountNumber: string, from: string, to: string): Promise<LedgerLineCandidate[]> {
    const rows = await tx`
      SELECT l.id AS line_id, e.id AS entry_id, e.number AS entry_number, j.code AS journal_code, e.entry_date::text AS entry_date,
             l.label, e.label AS entry_label, e.reference, l.debit::text AS debit, l.credit::text AS credit, l.partner_id
        FROM journal_line l
        JOIN journal_entry e ON e.id = l.entry_id
        JOIN journal j ON j.id = e.journal_id
        JOIN account a ON a.id = l.account_id
        LEFT JOIN bank_transaction bt ON bt.matched_line_id = l.id AND bt.status = 'MATCHED'
       WHERE l.tenant_id = ${this.ctx.tenantId} AND a.number = ${accountNumber} AND e.status = 'VALIDATED'
         AND e.entry_date BETWEEN ${from} AND ${to} AND bt.id IS NULL
       ORDER BY e.entry_date, e.number`;
    return rows.map(mapCandidate);
  }

  /** Candidats du grand livre pour une ligne de relevé (même montant, fenêtre de dates). */
  async candidateLines(transactionId: Id): Promise<LedgerLineCandidate[]> {
    return this.tx(async (tx) => {
      const t = await this.loadTransaction(tx, transactionId);
      const account = await this.loadAccount(tx, t.treasuryAccountId);
      const w = this.matchOpts.dateWindowDays;
      const lines = await this.unmatchedLines(tx, account.accountNumber, shiftDate(t.date, -w), shiftDate(t.date, w));
      return lines.filter((l) => l.amount.eq(t.amount));
    });
  }

  private async lineBalance(tx: Sql, accountNumber: string, asOf: string): Promise<Money> {
    const [row] = await tx`
      SELECT coalesce(sum(l.debit), 0)::text AS d, coalesce(sum(l.credit), 0)::text AS c
        FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
       WHERE l.tenant_id = ${this.ctx.tenantId} AND a.number = ${accountNumber} AND e.status = 'VALIDATED' AND e.entry_date <= ${asOf}`;
    return Money.parse(row!.d as string).sub(Money.parse(row!.c as string));
  }

  /** Solde comptable (débit − crédit) du compte de trésorerie à une date. */
  async bookBalance(accountId: Id, asOf: string): Promise<Money> {
    return this.tx(async (tx) => this.lineBalance(tx, (await this.loadAccount(tx, accountId)).accountNumber, asOf));
  }

  /** Soldes comptables de tous les comptes actifs à une date. */
  async currentBalances(asOf: string, accountIds?: Id[]): Promise<Array<{ account: TreasuryAccount; balance: Money }>> {
    return this.tx(async (tx) => {
      const rows = await tx`SELECT * FROM treasury_account WHERE tenant_id = ${this.ctx.tenantId} AND active ORDER BY kind, label`;
      const out: Array<{ account: TreasuryAccount; balance: Money }> = [];
      for (const r of rows) {
        const account = mapAccount(r);
        if (accountIds && !accountIds.includes(account.id)) continue;
        out.push({ account, balance: await this.lineBalance(tx, account.accountNumber, asOf) });
      }
      return out;
    });
  }

  // ---------------------------------------------------------------------------
  // Rapprochement
  // ---------------------------------------------------------------------------

  async autoMatch(statementId: Id, options: MatchOptions = {}): Promise<AutoMatchResult> {
    const statement = await this.getStatement(statementId);
    const txs = await this.listTransactions(statementId, { status: "UNMATCHED" });
    return this.autoMatchTransactions(statement.treasuryAccountId, txs, options);
  }

  /** Rapproche toutes les lignes en attente d'un compte, tous relevés confondus. */
  async autoMatchAccount(accountId: Id, options: MatchOptions = {}): Promise<AutoMatchResult> {
    const txs = await this.tx(async (tx) => {
      await this.loadAccount(tx, accountId);
      return (await tx`${txSelect(tx)} WHERE t.tenant_id = ${this.ctx.tenantId} AND t.treasury_account_id = ${accountId} AND t.status = 'UNMATCHED' ORDER BY t.tx_date`).map(mapTransaction);
    });
    return this.autoMatchTransactions(accountId, txs, options);
  }

  private async autoMatchTransactions(accountId: Id, txs: BankTransaction[], options: MatchOptions): Promise<AutoMatchResult> {
    // Le seuil ne descend jamais sous le plancher, quelle que soit l'option reçue.
    const opts: Required<MatchOptions> = {
      ...this.matchOpts,
      ...stripUndefined(options),
      threshold: Math.max(MIN_AUTO_MATCH_THRESHOLD, options.threshold ?? this.matchOpts.threshold),
    };
    const result: AutoMatchResult = { matched: 0, unmatched: 0, llmConsulted: 0, decisions: [] };
    if (txs.length === 0) return result;

    const { lines, rules } = await this.tx(async (tx) => {
      const account = await this.loadAccount(tx, accountId);
      const dates = txs.map((t) => t.date).sort();
      const lines = await this.unmatchedLines(tx, account.accountNumber, shiftDate(dates[0]!, -opts.dateWindowDays), shiftDate(dates[dates.length - 1]!, opts.dateWindowDays));
      const rules = (await tx`SELECT * FROM bank_rule WHERE tenant_id = ${this.ctx.tenantId} AND active ORDER BY priority`).map(mapRule);
      return { lines, rules };
    });
    const lineById = new Map(lines.map((l) => [l.lineId, l]));
    const decisions = matchTransactions(
      txs.map((t) => ({ id: t.id, date: t.date, amount: t.amount, label: t.label, reference: t.reference })),
      lines.map((l) => ({ lineId: l.lineId, date: l.date, amount: l.amount, label: l.label, entryLabel: l.entryLabel, reference: l.reference })),
      opts,
    );

    const taken = new Set<string>();
    for (const d of decisions) if (d.autoMatch && d.best) taken.add(d.best.lineId);

    for (const d of decisions) {
      const t = txs.find((x) => x.id === d.transactionId)!;
      let method: MatchMethod | undefined;
      let lineId: string | null = null;
      let confidence = 0;
      if (d.autoMatch && d.best) {
        method = "AMOUNT_DATE";
        lineId = d.best.lineId;
        confidence = d.best.score;
      } else if (this.opts.llmMatcher && d.candidates.length > 0 && (d.reason === "AMBIGUOUS" || d.reason === "BELOW_THRESHOLD")) {
        // Libellés ambigus : le modèle choisit parmi les candidats ; le seuil s'applique à sa réponse.
        const free = d.candidates.filter((c) => !taken.has(c.lineId));
        if (free.length > 0) {
          result.llmConsulted++;
          try {
            const answer = await this.opts.llmMatcher.match(
              { tenantId: this.ctx.tenantId, userId: this.ctx.userId },
              {
                transaction: { id: t.id, date: t.date, label: t.label, amount: t.amount.toString(), reference: t.reference },
                candidates: free.map((c) => {
                  const l = lineById.get(c.lineId)!;
                  return { lineId: l.lineId, date: l.date, label: `${l.label} — ${l.entryLabel}`.trim(), amount: l.amount.toString(), reference: l.reference };
                }),
              },
            );
            if (answer.lineId && answer.confidence >= opts.threshold && free.some((c) => c.lineId === answer.lineId) && !taken.has(answer.lineId)) {
              method = "LLM";
              lineId = answer.lineId;
              confidence = answer.confidence;
              taken.add(answer.lineId);
            }
          } catch {
            // Une erreur du modèle laisse la ligne en attente ; jamais d'appariement par défaut.
          }
        }
      }
      const rule = findRule(rules, t.label, accountId);
      const entry: AutoMatchResult["decisions"][number] = {
        ...d,
        ...(method ? { method, confidence } : {}),
        ...(rule ? { suggestedRuleId: rule.id, suggestedAccountNumber: rule.accountNumber } : {}),
      };
      if (method && lineId) {
        await this.markMatched(t.id, lineId, method, confidence);
        result.matched++;
      } else result.unmatched++;
      result.decisions.push(entry);
    }
    return result;
  }

  private async markMatched(transactionId: Id, lineId: Id, method: MatchMethod, confidence: number): Promise<BankTransaction> {
    return this.tx(async (tx) => {
      const rows = await tx`
        UPDATE bank_transaction SET status = 'MATCHED', matched_line_id = ${lineId}, match_confidence = ${confidence.toFixed(4)}, match_method = ${method},
               matched_by = ${this.ctx.userId}, matched_at = ${this.now().toISOString()}
         WHERE tenant_id = ${this.ctx.tenantId} AND id = ${transactionId} AND status = 'UNMATCHED' RETURNING id`;
      if (rows.length === 0) throw new TreasuryError("INVALID_STATE", "Ligne de relevé déjà rapprochée ou ignorée");
      await this.audit(tx, "treasury.transaction.match", "bank_transaction", transactionId, { lineId, method, confidence });
      return this.loadTransaction(tx, transactionId);
    }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "23505") throw new TreasuryError("LINE_ALREADY_MATCHED", "Cette ligne du grand livre est déjà rapprochée", { lineId });
      throw e;
    });
  }

  /** Rapprochement manuel : la ligne doit être validée, sur le compte de trésorerie, de même montant. */
  async manualMatch(transactionId: Id, lineId: Id): Promise<BankTransaction> {
    await this.tx(async (tx) => {
      const t = await this.loadTransaction(tx, transactionId);
      if (t.status !== "UNMATCHED") throw new TreasuryError("INVALID_STATE", "Ligne de relevé déjà rapprochée ou ignorée");
      const account = await this.loadAccount(tx, t.treasuryAccountId);
      const rows = await tx`
        SELECT a.number, e.status, l.debit::text AS debit, l.credit::text AS credit
          FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
         WHERE l.tenant_id = ${this.ctx.tenantId} AND l.id = ${lineId}`;
      const l = rows[0];
      if (!l) throw new TreasuryError("LINE_NOT_FOUND", `Ligne ${lineId} introuvable`);
      if (l.number !== account.accountNumber) throw new TreasuryError("INVALID_INPUT", `La ligne n'est pas sur le compte ${account.accountNumber}`);
      if (l.status !== "VALIDATED") throw new TreasuryError("INVALID_STATE", "Seule une écriture validée se rapproche");
      const signed = Money.parse(l.debit as string).sub(Money.parse(l.credit as string));
      if (!signed.eq(t.amount)) throw new TreasuryError("AMOUNT_MISMATCH", `Montant ${signed.toString()} ≠ ${t.amount.toString()}`);
    });
    return this.markMatched(transactionId, lineId, "MANUAL", 1);
  }

  async unmatch(transactionId: Id): Promise<BankTransaction> {
    return this.tx(async (tx) => {
      const before = await this.loadTransaction(tx, transactionId);
      if (before.status === "UNMATCHED") throw new TreasuryError("INVALID_STATE", "Ligne déjà en attente");
      await tx`
        UPDATE bank_transaction SET status = 'UNMATCHED', matched_line_id = NULL, match_confidence = NULL, match_method = NULL, matched_by = NULL, matched_at = NULL
         WHERE tenant_id = ${this.ctx.tenantId} AND id = ${transactionId}`;
      await this.audit(tx, "treasury.transaction.unmatch", "bank_transaction", transactionId, { status: "UNMATCHED" }, { status: before.status, lineId: before.matchedLineId });
      return this.loadTransaction(tx, transactionId);
    });
  }

  /** Ignore une ligne (doublon bancaire, opération sans incidence comptable). */
  async ignore(transactionId: Id): Promise<BankTransaction> {
    return this.tx(async (tx) => {
      const before = await this.loadTransaction(tx, transactionId);
      if (before.status !== "UNMATCHED") throw new TreasuryError("INVALID_STATE", "Seule une ligne en attente peut être ignorée");
      await tx`UPDATE bank_transaction SET status = 'IGNORED', matched_by = ${this.ctx.userId}, matched_at = ${this.now().toISOString()} WHERE tenant_id = ${this.ctx.tenantId} AND id = ${transactionId}`;
      await this.audit(tx, "treasury.transaction.ignore", "bank_transaction", transactionId, { status: "IGNORED" });
      return this.loadTransaction(tx, transactionId);
    });
  }

  /**
   * Crée et valide l'écriture correspondant à une ligne de relevé (frais 631 / 521,
   * encaissement client 521 / 411…) via Ledger.post — mêmes contrôles que la saisie
   * manuelle (compte, tiers, période ouverte) — puis rapproche la ligne.
   */
  async createEntryFromTransaction(
    transactionId: Id,
    input: { accountNumber: string; partnerId?: Id; label?: string; ruleId?: Id; journalCode?: string; vatCode?: string },
  ): Promise<{ entry: JournalEntry; transaction: BankTransaction }> {
    const { t, account, rule } = await this.tx(async (tx) => {
      const t = await this.loadTransaction(tx, transactionId);
      if (t.status !== "UNMATCHED") throw new TreasuryError("INVALID_STATE", "Ligne de relevé déjà rapprochée ou ignorée");
      const account = await this.loadAccount(tx, t.treasuryAccountId);
      let rule: BankRule | null = null;
      if (input.ruleId) {
        const rows = await tx`SELECT * FROM bank_rule WHERE tenant_id = ${this.ctx.tenantId} AND id = ${input.ruleId}`;
        if (!rows[0]) throw new TreasuryError("RULE_NOT_FOUND", `Règle ${input.ruleId} introuvable`);
        rule = mapRule(rows[0]);
      }
      return { t, account, rule };
    });
    const amount = t.amount.abs();
    const partnerId = input.partnerId ?? rule?.partnerId ?? undefined;
    const counterpart = { accountNumber: input.accountNumber, ...(partnerId ? { partnerId } : {}), ...(input.vatCode ? { vatCode: input.vatCode } : {}), label: input.label ?? t.label };
    const treasuryLine = { accountNumber: account.accountNumber, label: input.label ?? t.label };
    const entry = await this.opts.ledger.post(this.actor, {
      journalCode: input.journalCode ?? journalFor(account.kind),
      date: t.date,
      label: input.label ?? t.label,
      source: "BANK",
      ...(t.reference ?? t.externalId ? { reference: (t.reference ?? t.externalId)! } : {}),
      lines: t.amount.isPositive()
        ? [
            { ...treasuryLine, debit: amount },
            { ...counterpart, credit: amount },
          ]
        : [
            { ...counterpart, debit: amount },
            { ...treasuryLine, credit: amount },
          ],
    });
    const line = entry.lines.find((l) => l.accountNumber === account.accountNumber)!;
    const transaction = await this.markMatched(t.id, line.id, rule ? "RULE" : "MANUAL", 1);
    return { entry, transaction };
  }

  async reconciliationReport(accountId: Id, asOf: string): Promise<ReconciliationReport> {
    return this.tx(async (tx) => {
      const account = await this.loadAccount(tx, accountId);
      const bookBalance = await this.lineBalance(tx, account.accountNumber, asOf);
      const [first] = await tx`SELECT min(period_from)::text AS f FROM bank_statement WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId}`;
      const reconciledFrom = (first?.f as string | null) ?? null;
      const last = await tx`
        SELECT id, closing_balance::text AS c FROM bank_statement
         WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} AND period_to <= ${asOf} AND closing_balance IS NOT NULL
         ORDER BY period_to DESC, imported_at DESC LIMIT 1`;
      const statementBalance = last[0] ? Money.parse(last[0].c as string) : null;

      const unbooked = (
        await tx`${txSelect(tx)} WHERE t.tenant_id = ${this.ctx.tenantId} AND t.treasury_account_id = ${accountId} AND t.status = 'UNMATCHED' AND t.tx_date <= ${asOf} ORDER BY t.tx_date`
      ).map(mapTransaction);
      const uncleared = reconciledFrom ? await this.unmatchedLines(tx, account.accountNumber, reconciledFrom, asOf) : [];
      const [ignored] = await tx`SELECT count(*)::int AS n FROM bank_transaction WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} AND status = 'IGNORED' AND tx_date <= ${asOf}`;

      const adjustedBook = bookBalance.add(sum(unbooked.map((t) => t.amount)));
      const adjustedStatement = statementBalance ? statementBalance.add(sum(uncleared.map((l) => l.amount))) : null;
      const difference = adjustedStatement ? adjustedBook.sub(adjustedStatement) : null;

      const anomalies: CashCountAnomaly[] = [];
      if (account.kind === "CASH") {
        const counts = await tx`
          SELECT id, counted_on::text AS counted_on, difference::text AS difference, note FROM cash_count
           WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} AND counted_on <= ${asOf} ORDER BY counted_on DESC`;
        for (const c of counts) {
          const diff = Money.parse(c.difference as string);
          if (this.isCashAnomaly(diff)) anomalies.push({ cashCountId: c.id as string, countedOn: c.counted_on as string, difference: diff.toString(), note: (c.note as string | null) ?? null });
        }
      }
      return {
        account,
        asOf,
        bookBalance: bookBalance.toString(),
        statementBalance: statementBalance ? statementBalance.toString() : null,
        statementId: last[0] ? (last[0].id as string) : null,
        reconciledFrom,
        unbookedTransactions: unbooked.map((t) => ({ id: t.id, date: t.date, label: t.label, amount: t.amount.toString() })),
        unclearedLines: uncleared.map((l) => ({ id: l.lineId, date: l.date, label: l.label || l.entryLabel, amount: l.amount.toString() })),
        ignoredTransactions: Number(ignored!.n),
        adjustedBookBalance: adjustedBook.toString(),
        adjustedStatementBalance: adjustedStatement ? adjustedStatement.toString() : null,
        difference: difference ? difference.toString() : null,
        balanced: difference !== null && difference.isZero(),
        cashCountAnomalies: anomalies,
      };
    });
  }

  private isCashAnomaly(difference: Money): boolean {
    return difference.abs().cmp(this.cashThreshold) > 0 || (this.cashThreshold.isZero() && !difference.isZero());
  }

  // ---------------------------------------------------------------------------
  // Caisse
  // ---------------------------------------------------------------------------

  async recordCashCount(accountId: Id, input: CashCountInput): Promise<CashCountResult> {
    const counted = Money.parse(input.countedAmount);
    const { account, book } = await this.tx(async (tx) => {
      const account = await this.loadAccount(tx, accountId);
      if (account.kind !== "CASH") throw new TreasuryError("INVALID_INPUT", "Le comptage ne concerne que les caisses");
      return { account, book: await this.lineBalance(tx, account.accountNumber, input.date) };
    });
    const difference = counted.sub(book);
    const warnings: string[] = [];
    const negativeCash = counted.isNegative() || book.isNegative();
    if (negativeCash) warnings.push("Caisse négative : solde compté ou comptable inférieur à zéro");
    const anomaly = this.isCashAnomaly(difference);
    if (anomaly) warnings.push(`Écart de caisse ${difference.toString()} au-delà du seuil ${this.cashThreshold.toString()}`);

    let entry: JournalEntry | null = null;
    if (input.postDifference && !difference.isZero()) {
      const shortage = this.opts.cashDifferenceAccounts?.shortage ?? "658";
      const surplus = this.opts.cashDifferenceAccounts?.surplus ?? "758";
      const label = `Écart de caisse du ${input.date}${input.note ? ` — ${input.note}` : ""}`;
      entry = await this.opts.ledger.post(this.actor, {
        journalCode: "CA",
        date: input.date,
        label,
        source: "MANUAL",
        lines: difference.isPositive()
          ? [
              { accountNumber: account.accountNumber, debit: difference, label },
              { accountNumber: surplus, credit: difference, label },
            ]
          : [
              { accountNumber: shortage, debit: difference.abs(), label },
              { accountNumber: account.accountNumber, credit: difference.abs(), label },
            ],
      });
    }
    const count = await this.tx(async (tx) => {
      const [row] = await tx`
        INSERT INTO cash_count (tenant_id, treasury_account_id, counted_on, counted_amount, book_amount, difference, note, entry_id, counted_by)
        VALUES (${this.ctx.tenantId}, ${accountId}, ${input.date}, ${counted.toString()}, ${book.toString()}, ${difference.toString()}, ${input.note ?? null}, ${entry?.id ?? null}, ${this.ctx.userId})
        RETURNING id, tenant_id, treasury_account_id, counted_on::text AS counted_on, counted_amount::text AS counted_amount, book_amount::text AS book_amount,
                  difference::text AS difference, note, entry_id, counted_by, created_at`;
      const count = mapCashCount(row!);
      await this.audit(tx, "treasury.cash.count", "cash_count", count.id, { counted: counted.toString(), book: book.toString(), difference: difference.toString(), entryId: entry?.id ?? null });
      if (negativeCash) await this.audit(tx, "treasury.cash.negative", "cash_count", count.id, { counted: counted.toString(), book: book.toString() });
      if (anomaly) await this.audit(tx, "treasury.cash.anomaly", "cash_count", count.id, { difference: difference.toString(), threshold: this.cashThreshold.toString() });
      return count;
    });
    return { count, entry, negativeCash, anomaly, warnings };
  }

  async listCashCounts(accountId: Id): Promise<CashCount[]> {
    return this.tx(async (tx) => {
      await this.loadAccount(tx, accountId);
      const rows = await tx`
        SELECT id, tenant_id, treasury_account_id, counted_on::text AS counted_on, counted_amount::text AS counted_amount, book_amount::text AS book_amount,
               difference::text AS difference, note, entry_id, counted_by, created_at
          FROM cash_count WHERE tenant_id = ${this.ctx.tenantId} AND treasury_account_id = ${accountId} ORDER BY counted_on DESC, created_at DESC`;
      return rows.map(mapCashCount);
    });
  }

  // ---------------------------------------------------------------------------
  // Règles d'imputation
  // ---------------------------------------------------------------------------

  async listRules(): Promise<BankRule[]> {
    return this.tx(async (tx) => (await tx`SELECT * FROM bank_rule WHERE tenant_id = ${this.ctx.tenantId} ORDER BY priority, created_at`).map(mapRule));
  }

  async createRule(input: BankRuleInput): Promise<BankRule> {
    return this.tx(async (tx) => {
      if (input.isRegex) {
        try {
          new RegExp(input.pattern, "i");
        } catch {
          throw new TreasuryError("INVALID_INPUT", `Expression régulière invalide : ${input.pattern}`);
        }
      }
      const acc = await tx`SELECT postable, active FROM account WHERE tenant_id = ${this.ctx.tenantId} AND number = ${input.accountNumber}`;
      if (!acc[0] || !acc[0].postable || !acc[0].active) throw new TreasuryError("UNKNOWN_CHART_ACCOUNT", `Compte ${input.accountNumber} inconnu ou non imputable`);
      if (input.treasuryAccountId) await this.loadAccount(tx, input.treasuryAccountId);
      const [row] = await tx`
        INSERT INTO bank_rule (tenant_id, treasury_account_id, pattern, is_regex, account_number, partner_id, label, priority, active)
        VALUES (${this.ctx.tenantId}, ${input.treasuryAccountId ?? null}, ${input.pattern}, ${input.isRegex ?? false}, ${input.accountNumber}, ${input.partnerId ?? null},
                ${input.label ?? null}, ${input.priority ?? 100}, ${input.active ?? true}) RETURNING *`;
      const rule = mapRule(row!);
      await this.audit(tx, "treasury.rule.create", "bank_rule", rule.id, rule);
      return rule;
    });
  }

  async deleteRule(id: Id): Promise<void> {
    await this.tx(async (tx) => {
      const rows = await tx`DELETE FROM bank_rule WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id} RETURNING id`;
      if (rows.length === 0) throw new TreasuryError("RULE_NOT_FOUND", `Règle ${id} introuvable`);
      await this.audit(tx, "treasury.rule.delete", "bank_rule", id);
    });
  }

  // ---------------------------------------------------------------------------
  // Prévision
  // ---------------------------------------------------------------------------

  /** Prévision 13 semaines : le solde de départ vient des comptes de trésorerie actifs, sauf s'il est fourni. */
  async forecast(asOf: string, inputs: Omit<ForecastInputs, "openingBalance"> & { openingBalance?: Money | string; accountIds?: Id[] }): Promise<Forecast & { openingByAccount: Array<{ accountId: Id; label: string; balance: string }> }> {
    const { accountIds, openingBalance, ...rest } = inputs;
    const balances = await this.currentBalances(asOf, accountIds);
    const opening = openingBalance !== undefined ? Money.parse(openingBalance) : sum(balances.map((b) => b.balance));
    const forecast = forecast13Weeks(asOf, { ...rest, openingBalance: opening });
    return { ...forecast, openingByAccount: balances.map((b) => ({ accountId: b.account.id, label: b.account.label, balance: b.balance.toString() })) };
  }
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

export function journalFor(kind: TreasuryAccountKind): string {
  return kind === "CASH" ? "CA" : "BQ";
}

/** Empreinte d'un relevé : compte, source et lignes canoniques triées. */
export function statementHash(accountId: Id, source: StatementSource, rows: StatementRow[]): string {
  const canonical = rows
    .map((r) => [r.date, Money.parse(r.amount).toString(), r.label.trim().toLowerCase(), r.reference ?? "", r.externalId ?? ""].join("|"))
    .sort()
    .join("\n");
  return createHash("sha256").update(`${accountId}|${source}\n${canonical}`).digest("hex");
}

function rowKey(date: string, amount: string, label: string): string {
  return `${date}|${Money.parse(amount).toString()}|${label.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function shiftDate(iso: string, days: number): string {
  return new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days)).toISOString().slice(0, 10);
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function txSelect(tx: Sql) {
  return tx`
    SELECT t.id, t.tenant_id, t.statement_id, t.treasury_account_id, t.tx_date::text AS tx_date, t.value_date::text AS value_date, t.label, t.amount::text AS amount,
           t.reference, t.external_id, t.status, t.matched_line_id, t.match_confidence::text AS match_confidence, t.match_method, t.matched_by, t.matched_at, t.created_at
      FROM bank_transaction t`;
}

function mapAccount(r: Record<string, unknown>): TreasuryAccount {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    kind: r.kind as TreasuryAccountKind,
    label: r.label as string,
    accountNumber: r.account_number as string,
    currency: (r.currency as string).trim(),
    bankName: (r.bank_name as string | null) ?? null,
    iban: (r.iban as string | null) ?? null,
    mmOperator: (r.mm_operator as string | null) ?? null,
    mmPhone: (r.mm_phone as string | null) ?? null,
    active: Boolean(r.active),
    createdAt: toIso(r.created_at),
  };
}

function mapStatement(r: Record<string, unknown>): BankStatement {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    treasuryAccountId: r.treasury_account_id as string,
    periodFrom: r.period_from as string,
    periodTo: r.period_to as string,
    openingBalance: r.opening_balance ? Money.parse(r.opening_balance as string) : null,
    closingBalance: r.closing_balance ? Money.parse(r.closing_balance as string) : null,
    source: r.source as StatementSource,
    documentId: (r.document_id as string | null) ?? null,
    hash: r.hash as string,
    importedBy: (r.imported_by as string | null) ?? null,
    importedAt: toIso(r.imported_at),
  };
}

function mapTransaction(r: Record<string, unknown>): BankTransaction {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    statementId: r.statement_id as string,
    treasuryAccountId: r.treasury_account_id as string,
    date: r.tx_date as string,
    valueDate: (r.value_date as string | null) ?? null,
    label: r.label as string,
    amount: Money.parse(r.amount as string),
    reference: (r.reference as string | null) ?? null,
    externalId: (r.external_id as string | null) ?? null,
    status: r.status as TransactionStatus,
    matchedLineId: (r.matched_line_id as string | null) ?? null,
    matchConfidence: r.match_confidence === null || r.match_confidence === undefined ? null : Number(r.match_confidence),
    matchMethod: (r.match_method as MatchMethod | null) ?? null,
    matchedBy: (r.matched_by as string | null) ?? null,
    matchedAt: r.matched_at ? toIso(r.matched_at) : null,
    createdAt: toIso(r.created_at),
  };
}

function mapRule(r: Record<string, unknown>): BankRule {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    treasuryAccountId: (r.treasury_account_id as string | null) ?? null,
    pattern: r.pattern as string,
    isRegex: Boolean(r.is_regex),
    accountNumber: r.account_number as string,
    partnerId: (r.partner_id as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    priority: Number(r.priority),
    active: Boolean(r.active),
    createdAt: toIso(r.created_at),
  };
}

function mapCashCount(r: Record<string, unknown>): CashCount {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    treasuryAccountId: r.treasury_account_id as string,
    countedOn: r.counted_on as string,
    countedAmount: Money.parse(r.counted_amount as string),
    bookAmount: Money.parse(r.book_amount as string),
    difference: Money.parse(r.difference as string),
    note: (r.note as string | null) ?? null,
    entryId: (r.entry_id as string | null) ?? null,
    countedBy: (r.counted_by as string | null) ?? null,
    createdAt: toIso(r.created_at),
  };
}

function mapCandidate(r: Record<string, unknown>): LedgerLineCandidate {
  return {
    lineId: r.line_id as string,
    entryId: r.entry_id as string,
    entryNumber: r.entry_number === null ? null : Number(r.entry_number),
    journalCode: r.journal_code as string,
    date: r.entry_date as string,
    label: r.label as string,
    entryLabel: r.entry_label as string,
    reference: (r.reference as string | null) ?? null,
    amount: Money.parse(r.debit as string).sub(Money.parse(r.credit as string)),
    partnerId: (r.partner_id as string | null) ?? null,
  };
}
