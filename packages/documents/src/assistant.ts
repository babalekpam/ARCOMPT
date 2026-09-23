// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { withTenant } from "@arcompt/db";
import { AiGateway, AssistantToolCallSchema, type AssistantToolCall } from "@arcompt/ai-gateway";
import { Money, type AccountBalance, type Ledger } from "@arcompt/ledger";
import { computeStatements, SYSCOHADA_REVISE_2017_1, type StatementCode } from "@arcompt/statements";
import type { Sql } from "postgres";
import { z } from "zod";
import { DocumentsError } from "./errors.js";
import { ASSISTANT_ANSWER_PROMPT_VERSION, ASSISTANT_ANSWER_SYSTEM, ASSISTANT_FOOTER, ASSISTANT_TOOL_PROMPT_VERSION, ASSISTANT_TOOL_SYSTEM } from "./prompts.js";
import { findSuspiciousOutput, wrapUntrusted } from "./security.js";
import type { TenantContext } from "./types.js";

/**
 * Assistant : le modèle choisit un outil typé en lecture seule, le serveur
 * l'exécute avec le tenant du contexte (jamais un paramètre du modèle), puis
 * le modèle rédige la réponse en français. Aucun SQL ne vient du modèle.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const AgedArgs = z.object({ as_of: isoDate.optional() });
const RangeArgs = z.object({ fiscal_year: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() });
const ExplainArgs = z.object({ statement: z.enum(["BILAN_ACTIF", "BILAN_PASSIF", "COMPTE_RESULTAT", "TFT"]), code: z.string().min(1), fiscal_year: z.string().optional() });
type AgedArgsT = z.infer<typeof AgedArgs>;
type RangeArgsT = z.infer<typeof RangeArgs>;
type ExplainArgsT = z.infer<typeof ExplainArgs>;

export type AssistantToolName = AssistantToolCall["tool"];

export interface AgedPartner {
  partnerId: string | null;
  name: string;
  balance: string;
  buckets: { current: string; d31_60: string; d61_90: string; over90: string };
}

export interface AssistantToolsOptions {
  db: Sql;
  ctx: TenantContext;
  ledger: Ledger;
  baseCurrency: string;
  accountingSystem?: "NORMAL" | "SMT";
  now?: () => Date;
}

export class AssistantTools {
  private readonly now: () => Date;
  constructor(private readonly opts: AssistantToolsOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.opts.db, this.opts.ctx, fn);
  }

  /** Exécute un appel d'outil validé ; les arguments sont vérifiés par schéma. */
  async run(call: AssistantToolCall): Promise<unknown> {
    switch (call.tool) {
      case "get_aged_receivables":
        return this.getAgedReceivables(AgedArgs.parse(call.arguments));
      case "get_aged_payables":
        return this.getAgedPayables(AgedArgs.parse(call.arguments));
      case "get_cash_position":
        return this.getCashPosition();
      case "get_trial_balance":
        return this.getTrialBalance(RangeArgs.parse(call.arguments));
      case "get_vat_summary":
        return this.getVatSummary(RangeArgs.parse(call.arguments));
      case "explain_statement_line":
        return this.explainStatementLine(ExplainArgs.parse(call.arguments));
      default:
        throw new DocumentsError("UNKNOWN_TOOL", `Outil inconnu : ${String((call as { tool: string }).tool)}`);
    }
  }

  async getAgedReceivables(args: AgedArgsT = {}) {
    return this.aged("411", "D", args.as_of ?? this.today());
  }

  async getAgedPayables(args: AgedArgsT = {}) {
    return this.aged("401", "C", args.as_of ?? this.today());
  }

  /** Lignes non lettrées sur 411 / 401 par tiers et par ancienneté (30 / 60 / 90 jours). */
  private async aged(root: "411" | "401", side: "D" | "C", asOf: string) {
    const rows = await this.tx(
      (tx) => tx`
      SELECT p.id AS partner_id, coalesce(p.name, 'Sans tiers') AS name, e.entry_date::text AS entry_date, l.debit::text AS debit, l.credit::text AS credit
        FROM journal_line l
        JOIN journal_entry e ON e.id = l.entry_id
        JOIN account a ON a.id = l.account_id
        LEFT JOIN partner p ON p.id = l.partner_id
       WHERE l.tenant_id = ${this.opts.ctx.tenantId} AND e.status = 'VALIDATED' AND a.number LIKE ${root + "%"} AND e.entry_date <= ${asOf}
         AND NOT EXISTS (SELECT 1 FROM reconciliation_line rl JOIN reconciliation r ON r.id = rl.reconciliation_id WHERE rl.line_id = l.id AND r.kind = 'LETTRAGE')
       ORDER BY e.entry_date`,
    );
    const asOfMs = Date.parse(asOf);
    const partners = new Map<string, { partnerId: string | null; name: string; balance: Money; b: Money[] }>();
    for (const r of rows) {
      const key = (r.partner_id as string | null) ?? "-";
      const cur = partners.get(key) ?? { partnerId: (r.partner_id as string | null) ?? null, name: r.name as string, balance: Money.zero(), b: [Money.zero(), Money.zero(), Money.zero(), Money.zero()] };
      const net = side === "D" ? Money.parse(r.debit as string).sub(Money.parse(r.credit as string)) : Money.parse(r.credit as string).sub(Money.parse(r.debit as string));
      const days = Math.floor((asOfMs - Date.parse(r.entry_date as string)) / 86400000);
      const idx = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
      cur.balance = cur.balance.add(net);
      cur.b[idx] = cur.b[idx]!.add(net);
      partners.set(key, cur);
    }
    const list: AgedPartner[] = [...partners.values()]
      .filter((p) => !p.balance.isZero())
      .map((p) => ({ partnerId: p.partnerId, name: p.name, balance: p.balance.toString(), buckets: { current: p.b[0]!.toString(), d31_60: p.b[1]!.toString(), d61_90: p.b[2]!.toString(), over90: p.b[3]!.toString() } }));
    let total = Money.zero();
    for (const p of partners.values()) total = total.add(p.balance);
    return { as_of: asOf, currency: this.opts.baseCurrency, account: root, partners: list, total: total.toString() };
  }

  /** Soldes de trésorerie : banques (52), établissements financiers (53), caisse (57). */
  async getCashPosition() {
    const rows = await this.tx(
      (tx) => tx`
      SELECT a.number, a.label, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
        FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
       WHERE l.tenant_id = ${this.opts.ctx.tenantId} AND e.status = 'VALIDATED' AND a.number ~ '^(52|53|57)'
       GROUP BY a.number, a.label ORDER BY a.number`,
    );
    let total = Money.zero();
    const accounts = rows.map((r) => {
      const balance = Money.parse(r.debit as string).sub(Money.parse(r.credit as string));
      total = total.add(balance);
      return { number: r.number as string, label: r.label as string, balance: balance.toString() };
    });
    return { currency: this.opts.baseCurrency, accounts, total: total.toString() };
  }

  async getTrialBalance(args: RangeArgsT = {}) {
    const fy = args.fiscal_year ?? (await this.defaultFiscalYear());
    const tb = await this.opts.ledger.trialBalance(this.opts.ctx.tenantId, { fiscalYearCode: fy, ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) });
    return {
      fiscal_year: tb.fiscalYearCode,
      from: tb.from,
      to: tb.to,
      currency: this.opts.baseCurrency,
      rows: tb.rows.map((r) => ({ account: r.accountNumber, label: r.label, debit: r.debit.toString(), credit: r.credit.toString() })),
      total_debit: tb.totalDebit.toString(),
      total_credit: tb.totalCredit.toString(),
    };
  }

  /** TVA collectée (443), déductible (445), solde à payer ou crédit. */
  async getVatSummary(args: RangeArgsT = {}) {
    const range = await this.range(args);
    const rows = await this.tx(
      (tx) => tx`
      SELECT substr(a.number, 1, 3) AS root, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
        FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
       WHERE l.tenant_id = ${this.opts.ctx.tenantId} AND e.status = 'VALIDATED' AND (a.number LIKE '443%' OR a.number LIKE '445%') AND e.entry_date BETWEEN ${range.from} AND ${range.to}
       GROUP BY substr(a.number, 1, 3)`,
    );
    let collected = Money.zero();
    let deductible = Money.zero();
    for (const r of rows) {
      if (r.root === "443") collected = Money.parse(r.credit as string).sub(Money.parse(r.debit as string));
      if (r.root === "445") deductible = Money.parse(r.debit as string).sub(Money.parse(r.credit as string));
    }
    const net = collected.sub(deductible);
    return { ...range, currency: this.opts.baseCurrency, collected: collected.toString(), deductible: deductible.toString(), net: net.toString(), position: net.isNegative() ? "CREDIT_DE_TVA" : "TVA_A_PAYER" };
  }

  /** Explique un poste des états financiers : libellé, formule, comptes mouvementés, montant. */
  async explainStatementLine(args: ExplainArgsT) {
    const statement: StatementCode = args.statement;
    const template = SYSCOHADA_REVISE_2017_1.statements.find((s) => s.code === statement);
    const def = template?.lines.find((l) => l.code.toUpperCase() === args.code.toUpperCase());
    if (!template || !def) throw new DocumentsError("UNKNOWN_TOOL", `Poste ${args.code} inconnu dans ${args.statement}`);
    const fy = args.fiscal_year ?? (await this.defaultFiscalYear());
    const tb = await this.opts.ledger.trialBalance(this.opts.ctx.tenantId, { fiscalYearCode: fy });
    const balance: AccountBalance[] = tb.rows;
    const out = computeStatements({ system: this.opts.accountingSystem ?? "NORMAL", currency: this.opts.baseCurrency, fiscalYearCode: fy, balance });
    const computed = out.statements[statement]?.byCode[def.code];
    return {
      statement: args.statement,
      title: template.title,
      code: def.code,
      label: def.label,
      note: def.note ?? null,
      formula: def.formula ?? def.brut ?? null,
      sum_of: def.sum ?? null,
      accounts: computed?.accounts ?? [],
      amount: computed?.net.toString() ?? "0.0000",
      currency: this.opts.baseCurrency,
      fiscal_year: fy,
    };
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private async defaultFiscalYear(): Promise<string> {
    const today = this.today();
    const rows = await this.tx((tx) => tx`SELECT code FROM fiscal_year WHERE tenant_id = ${this.opts.ctx.tenantId} ORDER BY (${today}::date BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
    if (!rows[0]) throw new DocumentsError("UNKNOWN_TOOL", "Aucun exercice dans le dossier");
    return rows[0].code as string;
  }

  private async range(args: RangeArgsT): Promise<{ from: string; to: string; fiscal_year: string }> {
    const fy = args.fiscal_year ?? (await this.defaultFiscalYear());
    const rows = await this.tx((tx) => tx`SELECT start_date::text AS s, end_date::text AS e FROM fiscal_year WHERE tenant_id = ${this.opts.ctx.tenantId} AND code = ${fy}`);
    const s = (rows[0]?.s as string | undefined) ?? args.from ?? this.today();
    const e = (rows[0]?.e as string | undefined) ?? args.to ?? this.today();
    return { fiscal_year: fy, from: args.from ?? s, to: args.to ?? e };
  }
}

const AnswerSchema = z.object({ answer: z.string().min(1) });

export interface AssistantAnswer {
  answer: string;
  tool: AssistantToolName;
  arguments: Record<string, unknown>;
  data: unknown;
}

/** Une question → choix d'outil (JSON strict) → exécution serveur → réponse en français avec pied de page obligatoire. */
export async function askAssistant(gateway: AiGateway, tools: AssistantTools, ctx: TenantContext, question: string): Promise<AssistantAnswer> {
  const q = wrapUntrusted(question.slice(0, 2000));
  const { data: call } = await gateway.callJson(
    { tenantId: ctx.tenantId, userId: ctx.userId },
    { capability: "assistant", promptVersion: ASSISTANT_TOOL_PROMPT_VERSION, system: ASSISTANT_TOOL_SYSTEM, input: { question: q }, maxTokens: 300 },
    AssistantToolCallSchema,
  );
  const data = await tools.run(call);
  const { data: phrased } = await gateway.callJson(
    { tenantId: ctx.tenantId, userId: ctx.userId },
    { capability: "assistant", promptVersion: ASSISTANT_ANSWER_PROMPT_VERSION, system: ASSISTANT_ANSWER_SYSTEM, input: { question: q, tool: call.tool, tool_result: data }, maxTokens: 800 },
    AnswerSchema,
  );
  const suspicion = findSuspiciousOutput(phrased.answer, [question, JSON.stringify(data)]);
  const answer = suspicion.suspicious ? "La réponse générée contenait des éléments suspects et a été retenue. Consultez les données brutes de l'outil." : phrased.answer;
  return { answer: `${answer.trim()}\n\n${ASSISTANT_FOOTER}`, tool: call.tool, arguments: call.arguments, data };
}
