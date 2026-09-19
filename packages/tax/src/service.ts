import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { Money, type Actor, type Id, type JournalLineInput, type Ledger } from "@arcompt/ledger";
import { computeStatements, type StatementsOutput } from "@arcompt/statements";
import type { CountryPack } from "@arcompt/country-packs";
import { filingCalendar } from "./calendar.js";
import { buildDsfData, dsfWorkbook } from "./dsf.js";
import { computeIsInstalments } from "./is.js";
import {
  DEFAULT_VAT_ACCOUNTS,
  TaxError,
  type Deadline,
  type DsfAdjustments,
  type DsfResult,
  type IsComputation,
  type TaxReturn,
  type TaxReturnKind,
  type VatAccounts,
  type VatLine,
  type VatReturnComputation,
  type WithholdingRegister,
  type WithholdingRow,
} from "./types.js";
import { computeVatReturn } from "./vat.js";

export interface TaxServiceDeps {
  db: Sql;
  ledger: Ledger;
  ctx: { tenantId: Id; userId: Id; organizationId?: Id };
  currency: string;
  system?: "NORMAL" | "SMT";
  /** Pack pays du dossier (règles IS, taux, calendrier). Sans pack : TVA par soustraction, IS/DSF/calendrier indisponibles. */
  pack?: CountryPack;
  accounts?: Partial<VatAccounts>;
  company?: { name: string; taxIds?: Record<string, string> };
  now?: () => Date;
}

interface FiscalYearRow {
  id: Id;
  code: string;
  startDate: string;
  endDate: string;
}

/**
 * Fiscalité : TVA périodique, acomptes IS, registre des retenues, DSF,
 * calendrier. Le grand livre est écrit uniquement via Ledger.post.
 */
export class TaxService {
  private readonly now: () => Date;
  private readonly accounts: VatAccounts;

  constructor(private readonly deps: TaxServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.accounts = { ...DEFAULT_VAT_ACCOUNTS, ...deps.accounts };
  }

  private get actor(): Actor {
    return { userId: this.deps.ctx.userId, tenantId: this.deps.ctx.tenantId };
  }

  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.deps.db, this.deps.ctx, fn);
  }

  private requirePack(): CountryPack {
    if (!this.deps.pack) throw new TaxError("PACK_REQUIRED", "Pack pays requis pour ce calcul");
    return this.deps.pack;
  }

  // ---------------------------------------------------------------------------
  // TVA
  // ---------------------------------------------------------------------------

  /** Lignes 443x / 445x validées sur la période, agrégées par compte et code TVA. */
  async vatLines(from: string, to: string): Promise<VatLine[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT a.number, l.vat_code, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
          FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
         WHERE e.tenant_id = ${this.deps.ctx.tenantId} AND e.status = 'VALIDATED' AND e.entry_date BETWEEN ${from} AND ${to}
           AND e.source <> 'TAX'
           AND (a.number LIKE ${this.accounts.collected + "%"} OR a.number LIKE ${this.accounts.deductible + "%"})
         GROUP BY a.number, l.vat_code ORDER BY a.number, l.vat_code`;
      return rows.map((r) => ({ accountNumber: r.number as string, vatCode: (r.vat_code as string | null) ?? null, debit: Money.parse(r.debit as string), credit: Money.parse(r.credit as string) }));
    });
  }

  /** Calcule (ou recalcule) la déclaration de TVA d'une période et l'enregistre en COMPUTED. */
  async computeVat(input: { from: string; to: string; previousCredit?: string }): Promise<{ taxReturn: TaxReturn; computation: VatReturnComputation }> {
    if (input.to < input.from) throw new TaxError("INVALID_INPUT", "Période invalide");
    const existing = await this.findReturn("VAT", input.from, input.to);
    if (existing && (existing.status === "VALIDATED" || existing.status === "FILED")) {
      throw new TaxError("INVALID_STATE", `Déclaration ${existing.id} déjà ${existing.status === "FILED" ? "déposée" : "validée"}`);
    }
    const previousCredit = input.previousCredit ?? (await this.previousVatCredit(input.from));
    const lines = await this.vatLines(input.from, input.to);
    const computation = computeVatReturn({
      periodFrom: input.from,
      periodTo: input.to,
      lines,
      previousCredit,
      accounts: this.accounts,
      ...(this.deps.pack ? { pack: this.deps.pack } : {}),
    });
    const data = JSON.parse(JSON.stringify(computation)) as Record<string, unknown>;
    const taxReturn = existing
      ? await this.updateReturn(existing.id, { status: "COMPUTED", data, amountDue: computation.amountDue })
      : await this.insertReturn("VAT", input.from, input.to, "COMPUTED", data, computation.amountDue);
    await this.audit("tax.vat.compute", taxReturn.id, { from: input.from, to: input.to, amountDue: computation.amountDue.toString() });
    return { taxReturn, computation };
  }

  /** Crédit reporté par la dernière déclaration validée ou déposée antérieure à `before`. */
  private async previousVatCredit(before: string): Promise<string> {
    return this.tx(async (tx) => {
      const [r] = await tx`
        SELECT data->>'creditCarried' AS credit FROM tax_return
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND kind = 'VAT' AND status IN ('VALIDATED', 'FILED') AND period_to < ${before}
         ORDER BY period_to DESC LIMIT 1`;
      return (r?.credit as string | null) ?? "0";
    });
  }

  /**
   * Valide la déclaration : écriture de liquidation (443 D / 445 C / 444 C
   * pour la TVA due, ou 444 D — compte de crédit — si crédit). Le crédit
   * antérieur, déjà au débit du compte 444, s'impute naturellement.
   */
  async validateVat(id: Id, opts: { date?: string } = {}): Promise<TaxReturn> {
    const tr = await this.getReturn(id);
    if (tr.kind !== "VAT") throw new TaxError("INVALID_INPUT", "Déclaration de TVA attendue");
    if (tr.status !== "COMPUTED") throw new TaxError("INVALID_STATE", `Déclaration au statut ${tr.status} : seule une déclaration calculée se valide`);
    const collected = Money.parse(String(tr.data.totalCollected ?? "0"));
    const deductible = Money.parse(String(tr.data.totalDeductible ?? "0"));
    const net = Money.parse(String(tr.data.net ?? "0"));
    const lines: JournalLineInput[] = [];
    if (collected.isPositive()) lines.push({ accountNumber: this.accounts.collected, debit: collected, label: "TVA collectée de la période" });
    if (deductible.isPositive()) lines.push({ accountNumber: this.accounts.deductible, credit: deductible, label: "TVA déductible de la période" });
    if (net.isPositive()) lines.push({ accountNumber: this.accounts.due, credit: net, label: "TVA due" });
    else if (net.isNegative()) lines.push({ accountNumber: this.accounts.credit, debit: net.neg(), label: "Crédit de TVA" });
    let entryId: Id | null = null;
    if (lines.length >= 2) {
      const entry = await this.deps.ledger.post(this.actor, {
        journalCode: "OD",
        date: opts.date ?? tr.periodTo,
        label: `Liquidation TVA ${tr.periodFrom} → ${tr.periodTo}`,
        source: "TAX",
        reference: `TVA-${tr.periodTo}`,
        lines,
      });
      entryId = entry.id;
    }
    const updated = await this.updateReturn(id, { status: "VALIDATED", entryId });
    await this.audit("tax.vat.validate", id, { entryId });
    return updated;
  }

  /** Règlement : 444 D / trésorerie C. */
  async payVat(id: Id, opts: { date: string; treasuryAccount?: string }): Promise<TaxReturn> {
    const tr = await this.getReturn(id);
    if (tr.kind !== "VAT") throw new TaxError("INVALID_INPUT", "Déclaration de TVA attendue");
    if (tr.status !== "VALIDATED" && tr.status !== "FILED") throw new TaxError("INVALID_STATE", "Validez la déclaration avant de la payer");
    if (tr.paymentEntryId) throw new TaxError("INVALID_STATE", "Déclaration déjà réglée");
    if (!tr.amountDue.isPositive()) throw new TaxError("INVALID_STATE", "Aucun montant à payer (crédit de TVA)");
    const treasury = opts.treasuryAccount ?? "521";
    const entry = await this.deps.ledger.post(this.actor, {
      journalCode: treasury.startsWith("57") ? "CA" : "BQ",
      date: opts.date,
      label: `Paiement TVA ${tr.periodFrom} → ${tr.periodTo}`,
      source: "TAX",
      reference: `TVA-${tr.periodTo}`,
      lines: [
        { accountNumber: this.accounts.due, debit: tr.amountDue, label: "TVA due" },
        { accountNumber: treasury, credit: tr.amountDue, label: "Paiement TVA" },
      ],
    });
    const updated = await this.updateReturn(id, { paymentEntryId: entry.id });
    await this.audit("tax.vat.pay", id, { entryId: entry.id, amount: tr.amountDue.toString() });
    return updated;
  }

  /** Marque une déclaration comme déposée (référence du portail). */
  async markFiled(id: Id, filingReference: string): Promise<TaxReturn> {
    const tr = await this.getReturn(id);
    if (tr.status !== "VALIDATED" && tr.status !== "COMPUTED") throw new TaxError("INVALID_STATE", `Déclaration au statut ${tr.status}`);
    const updated = await this.updateReturn(id, { status: "FILED", filingReference, filedAt: this.now().toISOString() });
    await this.audit("tax.file", id, { filingReference });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // IS
  // ---------------------------------------------------------------------------

  async isInstalments(input: { fiscalYearCode: string; fiscalResult: string; turnover: string; instalments?: number }): Promise<{ taxReturn: TaxReturn; computation: IsComputation }> {
    const pack = this.requirePack();
    const fy = await this.fiscalYear(input.fiscalYearCode);
    const computation = computeIsInstalments({
      pack,
      date: fy.endDate,
      fiscalResult: input.fiscalResult,
      turnover: input.turnover,
      currency: this.deps.currency,
      ...(input.instalments !== undefined ? { instalments: input.instalments } : {}),
    });
    const existing = await this.findReturn("IS_INSTALMENT", fy.startDate, fy.endDate);
    if (existing && existing.status !== "COMPUTED" && existing.status !== "DRAFT") throw new TaxError("INVALID_STATE", `Acomptes ${existing.status}`);
    const data = JSON.parse(JSON.stringify(computation)) as Record<string, unknown>;
    const taxReturn = existing
      ? await this.updateReturn(existing.id, { status: "COMPUTED", data, amountDue: computation.due })
      : await this.insertReturn("IS_INSTALMENT", fy.startDate, fy.endDate, "COMPUTED", data, computation.due);
    await this.audit("tax.is.compute", taxReturn.id, { due: computation.due.toString() });
    return { taxReturn, computation };
  }

  // ---------------------------------------------------------------------------
  // Retenues à la source (447)
  // ---------------------------------------------------------------------------

  async withholdingRegister(from: string, to: string): Promise<WithholdingRegister> {
    const rows = await this.tx(async (tx) => {
      const r = await tx`
        SELECT e.id AS entry_id, e.entry_date::text AS entry_date, e.reference, e.label AS entry_label, l.label AS line_label, a.number,
               l.partner_id, p.name AS partner_name, l.debit::text AS debit, l.credit::text AS credit
          FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
          LEFT JOIN partner p ON p.id = l.partner_id
         WHERE e.tenant_id = ${this.deps.ctx.tenantId} AND e.status = 'VALIDATED' AND e.entry_date BETWEEN ${from} AND ${to} AND a.number LIKE '447%'
         ORDER BY e.entry_date, e.number, l.line_no`;
      return r.map<WithholdingRow>((x) => ({
        entryId: x.entry_id as Id,
        date: x.entry_date as string,
        reference: (x.reference as string | null) ?? null,
        entryLabel: x.entry_label as string,
        lineLabel: x.line_label as string,
        accountNumber: x.number as string,
        partnerId: (x.partner_id as Id | null) ?? null,
        partnerName: (x.partner_name as string | null) ?? null,
        withheld: Money.parse(x.credit as string),
        paid: Money.parse(x.debit as string),
      }));
    });
    const totalWithheld = rows.reduce((acc, r) => acc.add(r.withheld), Money.zero());
    const totalPaid = rows.reduce((acc, r) => acc.add(r.paid), Money.zero());
    return { from, to, rows, totalWithheld, totalPaid, balance: totalWithheld.sub(totalPaid) };
  }

  // ---------------------------------------------------------------------------
  // DSF
  // ---------------------------------------------------------------------------

  async statements(fiscalYearCode: string, previousFiscalYearCode?: string): Promise<StatementsOutput> {
    const current = await this.deps.ledger.trialBalance(this.deps.ctx.tenantId, { fiscalYearCode });
    const previous = previousFiscalYearCode ? await this.deps.ledger.trialBalance(this.deps.ctx.tenantId, { fiscalYearCode: previousFiscalYearCode }) : null;
    return computeStatements({
      system: this.deps.system ?? "NORMAL",
      currency: this.deps.currency,
      fiscalYearCode,
      balance: current.rows,
      ...(previous ? { previousBalance: previous.rows } : {}),
    });
  }

  /** Assemble la DSF (états + passage fiscal) et l'enregistre (kind DSF, COMPUTED). */
  async buildDsf(fiscalYearCode: string, opts: DsfAdjustments & { previousFiscalYearCode?: string }): Promise<{ dsf: DsfResult; taxReturn: TaxReturn }> {
    const pack = this.requirePack();
    const fy = await this.fiscalYear(fiscalYearCode);
    const statements = await this.statements(fiscalYearCode, opts.previousFiscalYearCode);
    const dsf = buildDsfData({ pack, statements, date: fy.endDate, adjustments: opts });
    const existing = await this.findReturn("DSF", fy.startDate, fy.endDate);
    if (existing && existing.status === "FILED") throw new TaxError("INVALID_STATE", "DSF déjà déposée");
    const data = JSON.parse(JSON.stringify({ fiscal: dsf.fiscal, controls: statements.controls, publishable: statements.publishable })) as Record<string, unknown>;
    const taxReturn = existing
      ? await this.updateReturn(existing.id, { status: "COMPUTED", data, amountDue: dsf.fiscal.isDue })
      : await this.insertReturn("DSF", fy.startDate, fy.endDate, "COMPUTED", data, dsf.fiscal.isDue);
    await this.audit("tax.dsf.build", taxReturn.id, { fiscalResult: dsf.fiscal.fiscalResult.toString(), isDue: dsf.fiscal.isDue.toString() });
    return { dsf, taxReturn };
  }

  async dsfWorkbook(fiscalYearCode: string, opts: DsfAdjustments & { previousFiscalYearCode?: string }): Promise<Buffer> {
    const { dsf } = await this.buildDsf(fiscalYearCode, opts);
    return dsfWorkbook(dsf, this.deps.company ? { company: this.deps.company } : {});
  }

  // ---------------------------------------------------------------------------
  // Calendrier
  // ---------------------------------------------------------------------------

  async calendar(year: number, today?: string): Promise<Deadline[]> {
    const pack = this.requirePack();
    const filed = await this.tx(async (tx) => {
      const rows = await tx`SELECT kind, period_from::text AS period_from, period_to::text AS period_to FROM tax_return WHERE tenant_id = ${this.deps.ctx.tenantId} AND status = 'FILED'`;
      return rows.map((r) => ({ kind: r.kind as TaxReturnKind, periodFrom: r.period_from as string, periodTo: r.period_to as string }));
    });
    return filingCalendar(pack, year, { filed, ...(today ? { today } : {}) });
  }

  // ---------------------------------------------------------------------------
  // Déclarations : lecture et persistance
  // ---------------------------------------------------------------------------

  async listReturns(kind?: TaxReturnKind): Promise<TaxReturn[]> {
    return this.tx(async (tx) => {
      const rows = kind
        ? await tx`SELECT ${returnColumns(tx)} FROM tax_return WHERE tenant_id = ${this.deps.ctx.tenantId} AND kind = ${kind} ORDER BY period_from DESC, created_at DESC`
        : await tx`SELECT ${returnColumns(tx)} FROM tax_return WHERE tenant_id = ${this.deps.ctx.tenantId} ORDER BY period_from DESC, created_at DESC`;
      return rows.map(mapReturn);
    });
  }

  async getReturn(id: Id): Promise<TaxReturn> {
    const tr = await this.tx(async (tx) => {
      const [r] = await tx`SELECT ${returnColumns(tx)} FROM tax_return WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${id}`;
      return r ? mapReturn(r) : null;
    });
    if (!tr) throw new TaxError("NOT_FOUND", `Déclaration ${id} introuvable`);
    return tr;
  }

  private async findReturn(kind: TaxReturnKind, from: string, to: string): Promise<TaxReturn | null> {
    return this.tx(async (tx) => {
      const [r] = await tx`
        SELECT ${returnColumns(tx)} FROM tax_return
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND kind = ${kind} AND period_from = ${from} AND period_to = ${to}
         ORDER BY created_at DESC LIMIT 1`;
      return r ? mapReturn(r) : null;
    });
  }

  private async insertReturn(kind: TaxReturnKind, from: string, to: string, status: TaxReturn["status"], data: Record<string, unknown>, amountDue: Money): Promise<TaxReturn> {
    return this.tx(async (tx) => {
      const [r] = await tx`
        INSERT INTO tax_return (tenant_id, kind, period_from, period_to, status, data, amount_due, created_by)
        VALUES (${this.deps.ctx.tenantId}, ${kind}, ${from}, ${to}, ${status}, ${tx.json(data as never)}, ${amountDue.toString()}, ${this.deps.ctx.userId})
        RETURNING ${returnColumns(tx)}`;
      return mapReturn(r!);
    });
  }

  private async updateReturn(
    id: Id,
    patch: { status?: TaxReturn["status"]; data?: Record<string, unknown>; amountDue?: Money; entryId?: Id | null; paymentEntryId?: Id; filingReference?: string; filedAt?: string },
  ): Promise<TaxReturn> {
    const current = await this.getReturn(id);
    return this.tx(async (tx) => {
      const [r] = await tx`
        UPDATE tax_return
           SET status = ${patch.status ?? current.status}, data = ${tx.json((patch.data ?? current.data) as never)},
               amount_due = ${(patch.amountDue ?? current.amountDue).toString()},
               entry_id = ${patch.entryId === undefined ? current.entryId : patch.entryId},
               payment_entry_id = ${patch.paymentEntryId ?? current.paymentEntryId},
               filing_reference = ${patch.filingReference ?? current.filingReference},
               filed_at = ${patch.filedAt ?? current.filedAt}, updated_at = ${this.now().toISOString()}
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${id}
         RETURNING ${returnColumns(tx)}`;
      return mapReturn(r!);
    });
  }

  private async fiscalYear(code: string): Promise<FiscalYearRow> {
    const fy = await this.tx(async (tx) => {
      const [r] = await tx`SELECT id, code, start_date::text AS start_date, end_date::text AS end_date FROM fiscal_year WHERE tenant_id = ${this.deps.ctx.tenantId} AND code = ${code}`;
      return r ? { id: r.id as Id, code: r.code as string, startDate: r.start_date as string, endDate: r.end_date as string } : null;
    });
    if (!fy) throw new TaxError("FISCAL_YEAR_NOT_FOUND", `Exercice ${code} introuvable`);
    return fy;
  }

  private async audit(action: string, entityId: Id, after: unknown): Promise<void> {
    await this.tx(async (tx) => {
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, ${action}, 'tax_return', ${entityId}, ${tx.json(after as never)}, ${this.now().toISOString()})`;
    });
  }
}

function returnColumns(tx: Sql) {
  return tx`id, tenant_id, kind, period_from::text AS period_from, period_to::text AS period_to, status, data, amount_due::text AS amount_due,
    entry_id, payment_entry_id, filing_reference, filed_at, created_at, updated_at`;
}

function mapReturn(r: Record<string, unknown>): TaxReturn {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
  return {
    id: r.id as Id,
    tenantId: r.tenant_id as Id,
    kind: r.kind as TaxReturnKind,
    periodFrom: r.period_from as string,
    periodTo: r.period_to as string,
    status: r.status as TaxReturn["status"],
    data: (r.data as Record<string, unknown>) ?? {},
    amountDue: Money.parse(r.amount_due as string),
    entryId: (r.entry_id as Id | null) ?? null,
    paymentEntryId: (r.payment_entry_id as Id | null) ?? null,
    filingReference: (r.filing_reference as string | null) ?? null,
    filedAt: iso(r.filed_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}
