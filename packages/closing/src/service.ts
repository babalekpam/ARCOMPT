// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { type Actor, type Id, type Ledger, type Period } from "@arcompt/ledger";
import { computeStatements, type Control } from "@arcompt/statements";
import { checklistAllowsClose, checklistTemplate } from "./checklist.js";
import { ClosingError, type ChecklistItem, type ChecklistScope, type ChecklistStatus, type FiscalYearWorkflow, type PeriodInfo, type WorkflowHistoryEntry, type WorkflowState } from "./types.js";
import { checkTransition } from "./workflow.js";

export interface ClosingServiceDeps {
  db: Sql;
  ledger: Ledger;
  ctx: { tenantId: Id; userId: Id; organizationId?: Id; roles: string[] };
  currency: string;
  system?: "NORMAL" | "SMT";
  now?: () => Date;
}

interface FiscalYearRow {
  id: Id;
  code: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED" | "LOCKED";
}

const UNLOCK_ROLES = ["OWNER", "REVIEWER"];

/**
 * Clôture assistée : listes de contrôle, clôture / déverrouillage de période,
 * verrouillage d'exercice et workflow Tenue → … → Verrouillé.
 */
export class ClosingService {
  private readonly now: () => Date;

  constructor(private readonly deps: ClosingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get actor(): Actor {
    return { userId: this.deps.ctx.userId, tenantId: this.deps.ctx.tenantId };
  }

  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.deps.db, this.deps.ctx, fn);
  }

  // ---------------------------------------------------------------------------
  // Listes de contrôle
  // ---------------------------------------------------------------------------

  /** Crée les items manquants du gabarit (idempotent) et renvoie la liste. */
  async generateChecklist(input: { fiscalYearCode: string; periodId?: string }): Promise<ChecklistItem[]> {
    const fy = await this.fiscalYear(input.fiscalYearCode);
    const scope: ChecklistScope = input.periodId ? "MONTHLY" : "ANNUAL";
    if (input.periodId) {
      const p = await this.period(input.periodId);
      if (p.fiscalYearId !== fy.id) throw new ClosingError("INVALID_INPUT", "Période hors de l'exercice");
    }
    const periodId = input.periodId ?? null;
    await this.tx(async (tx) => {
      const existing = new Set((await tx`SELECT item_key FROM closing_checklist WHERE tenant_id = ${this.deps.ctx.tenantId} AND fiscal_year_id = ${fy.id} AND period_id IS NOT DISTINCT FROM ${periodId}`).map((r) => r.item_key as string));
      for (const item of checklistTemplate(scope)) {
        if (existing.has(item.key)) continue;
        await tx`INSERT INTO closing_checklist (tenant_id, fiscal_year_id, period_id, item_key, label, blocking) VALUES (${this.deps.ctx.tenantId}, ${fy.id}, ${periodId}, ${item.key}, ${item.label}, ${item.blocking})`;
      }
    });
    return this.listChecklist(input);
  }

  async listChecklist(input: { fiscalYearCode: string; periodId?: string }): Promise<ChecklistItem[]> {
    const fy = await this.fiscalYear(input.fiscalYearCode);
    const periodId = input.periodId ?? null;
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT ${checklistColumns(tx)} FROM closing_checklist
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND fiscal_year_id = ${fy.id} AND period_id IS NOT DISTINCT FROM ${periodId}
         ORDER BY created_at, item_key`;
      return rows.map(mapItem);
    });
  }

  /** Coche (DONE), écarte (NA) ou rouvre (TODO) un item, avec justification. */
  async tick(itemId: Id, input: { status: ChecklistStatus; evidence?: Record<string, unknown> }): Promise<ChecklistItem> {
    const item = await this.tx(async (tx) => {
      const [current] = await tx`SELECT ${checklistColumns(tx)} FROM closing_checklist WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${itemId}`;
      if (!current) return null;
      const done = input.status !== "TODO";
      const [row] = await tx`
        UPDATE closing_checklist
           SET status = ${input.status}, done_by = ${done ? this.deps.ctx.userId : null}, done_at = ${done ? this.now().toISOString() : null},
               evidence = ${tx.json((input.evidence ?? current.evidence ?? {}) as never)}
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${itemId}
         RETURNING ${checklistColumns(tx)}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'closing.checklist.tick', 'closing_checklist', ${itemId},
                ${tx.json({ status: current.status })}, ${tx.json({ status: input.status, evidence: input.evidence ?? null } as never)}, ${this.now().toISOString()})`;
      return mapItem(row!);
    });
    if (!item) throw new ClosingError("NOT_FOUND", `Item ${itemId} introuvable`);
    return item;
  }

  // ---------------------------------------------------------------------------
  // Clôture de période
  // ---------------------------------------------------------------------------

  /**
   * Clôture une période : liste mensuelle sans item bloquant TODO ; pour la
   * dernière période de l'exercice, liste annuelle complète, autres périodes
   * déjà closes et contrôles bloquants des états financiers satisfaits.
   */
  async closePeriod(periodId: Id): Promise<PeriodInfo> {
    const p = await this.period(periodId);
    if (p.status !== "OPEN") throw new ClosingError("INVALID_STATE", `Période déjà ${p.status === "CLOSED" ? "clôturée" : "verrouillée"}`);
    const monthly = await this.generateChecklist({ fiscalYearCode: p.fiscalYearCode, periodId });
    const check = checklistAllowsClose(monthly);
    if (!check.ok) throw new ClosingError("CHECKLIST_INCOMPLETE", `Items bloquants à traiter : ${check.blocking.map((i) => i.key).join(", ")}`, { items: check.blocking.map((i) => ({ id: i.id, key: i.key, label: i.label })) });
    if (p.isLast) {
      const annual = await this.generateChecklist({ fiscalYearCode: p.fiscalYearCode });
      const annualCheck = checklistAllowsClose(annual);
      if (!annualCheck.ok) throw new ClosingError("CHECKLIST_INCOMPLETE", `Liste annuelle : items bloquants à traiter : ${annualCheck.blocking.map((i) => i.key).join(", ")}`, { items: annualCheck.blocking.map((i) => ({ id: i.id, key: i.key, label: i.label })) });
      const open = await this.tx(async (tx) => tx`SELECT id, start_date::text AS start_date FROM period WHERE tenant_id = ${this.deps.ctx.tenantId} AND fiscal_year_id = ${p.fiscalYearId} AND id <> ${periodId} AND status = 'OPEN' ORDER BY start_date`);
      if (open.length > 0) throw new ClosingError("PERIODS_OPEN", `Clôturez d'abord les périodes ouvertes : ${open.map((r) => r.start_date as string).join(", ")}`, { periods: open.map((r) => r.id as Id) });
      const failed = await this.failedBlockingControls(p.fiscalYearCode);
      if (failed.length > 0) throw new ClosingError("CONTROLS_FAILED", `Contrôles bloquants en échec : ${failed.map((c) => c.id).join(", ")}`, { controls: failed });
    }
    await this.deps.ledger.closePeriod(this.actor, toPeriod(p, this.deps.ctx.tenantId), "CLOSED");
    if (p.isLast) {
      await this.tx(async (tx) => {
        await tx`UPDATE fiscal_year SET status = 'CLOSED' WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${p.fiscalYearId} AND status = 'OPEN'`;
      });
    }
    return { ...p, status: "CLOSED" };
  }

  /**
   * Déverrouillage d'une période close (SECURITY.md §4 et §6) : commentaire
   * obligatoire, approbateur REVIEWER ou OWNER différent du demandeur, trace
   * `period.unlock` dans audit_log. Une période LOCKED (exercice verrouillé)
   * ne se rouvre pas.
   */
  async unlockPeriod(periodId: Id, input: { comment: string; approverId: Id }): Promise<PeriodInfo> {
    if (!input.comment || input.comment.trim().length < 5) throw new ClosingError("COMMENT_REQUIRED", "Un commentaire motivant le déverrouillage est requis");
    if (!this.deps.ctx.roles.some((r) => UNLOCK_ROLES.includes(r))) throw new ClosingError("FORBIDDEN", `Déverrouillage réservé aux rôles ${UNLOCK_ROLES.join(" ou ")}`);
    if (input.approverId === this.deps.ctx.userId) throw new ClosingError("SEPARATION_OF_DUTIES", "L'approbateur doit être différent du demandeur");
    const p = await this.period(periodId);
    if (p.status === "LOCKED") throw new ClosingError("INVALID_STATE", "Période verrouillée : l'exercice est clos définitivement");
    if (p.status !== "CLOSED") throw new ClosingError("INVALID_STATE", "La période n'est pas clôturée");
    const approverOk = await this.tx(async (tx) => {
      const [m] = await tx`SELECT role FROM company_member WHERE company_id = ${this.deps.ctx.tenantId} AND user_id = ${input.approverId}`;
      return m !== undefined && UNLOCK_ROLES.includes(m.role as string);
    });
    if (!approverOk) throw new ClosingError("FORBIDDEN", "L'approbateur doit être membre du dossier avec le rôle REVIEWER ou OWNER");
    await this.tx(async (tx) => {
      await tx`UPDATE period SET status = 'OPEN' WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${periodId} AND status = 'CLOSED'`;
      await tx`UPDATE fiscal_year SET status = 'OPEN' WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${p.fiscalYearId} AND status = 'CLOSED'`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'period.unlock', 'period', ${periodId},
                ${tx.json({ status: "CLOSED" })}, ${tx.json({ status: "OPEN", comment: input.comment, approverId: input.approverId, requestedBy: this.deps.ctx.userId })}, ${this.now().toISOString()})`;
    });
    return { ...p, status: "OPEN" };
  }

  /** Verrouille définitivement toutes les périodes de l'exercice. */
  async lockFiscalYear(fiscalYearCode: string): Promise<FiscalYearRow> {
    const fy = await this.fiscalYear(fiscalYearCode);
    const periods = await this.tx(async (tx) => tx`SELECT id, start_date::text AS start_date, end_date::text AS end_date, status FROM period WHERE tenant_id = ${this.deps.ctx.tenantId} AND fiscal_year_id = ${fy.id} ORDER BY start_date`);
    for (const r of periods) {
      if (r.status === "LOCKED") continue;
      await this.deps.ledger.closePeriod(this.actor, { id: r.id as Id, tenantId: this.deps.ctx.tenantId, fiscalYearId: fy.id, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as Period["status"] }, "LOCKED");
    }
    await this.tx(async (tx) => {
      await tx`UPDATE fiscal_year SET status = 'LOCKED' WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${fy.id}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'fiscal_year.lock', 'fiscal_year', ${fy.id}, ${tx.json({ status: fy.status })}, ${tx.json({ status: "LOCKED" })}, ${this.now().toISOString()})`;
    });
    return { ...fy, status: "LOCKED" };
  }

  // ---------------------------------------------------------------------------
  // Workflow de l'exercice
  // ---------------------------------------------------------------------------

  async getWorkflow(fiscalYearCode: string): Promise<FiscalYearWorkflow> {
    const fy = await this.fiscalYear(fiscalYearCode);
    return this.tx(async (tx) => {
      const [existing] = await tx`SELECT ${workflowColumns(tx)} FROM fiscal_year_workflow WHERE tenant_id = ${this.deps.ctx.tenantId} AND fiscal_year_id = ${fy.id}`;
      if (existing) return mapWorkflow(existing, fy.code);
      const [row] = await tx`INSERT INTO fiscal_year_workflow (tenant_id, fiscal_year_id) VALUES (${this.deps.ctx.tenantId}, ${fy.id}) RETURNING ${workflowColumns(tx)}`;
      return mapWorkflow(row!, fy.code);
    });
  }

  /**
   * Transition du workflow. REVISION → ETATS exige des états publiables ;
   * VISA → DEPOT exige un rôle REVIEWER/OWNER différent de celui qui a
   * produit les états ; DEPOT → VERROUILLE exige l'accusé de dépôt et
   * verrouille toutes les périodes.
   */
  async transition(fiscalYearCode: string, to: WorkflowState, opts: { comment?: string; filingReceiptDocumentId?: Id } = {}): Promise<FiscalYearWorkflow> {
    const wf = await this.getWorkflow(fiscalYearCode);
    const receipt = opts.filingReceiptDocumentId ?? wf.filingReceiptDocumentId;
    const preparedBy = [...wf.history].reverse().find((h) => h.to === "ETATS")?.by ?? null;
    let controlsOk: boolean | undefined;
    let failedControls: Control[] = [];
    if (wf.state === "REVISION" && to === "ETATS") {
      failedControls = await this.failedBlockingControls(fiscalYearCode);
      controlsOk = failedControls.length === 0;
    }
    const check = checkTransition(wf.state, to, {
      actor: { userId: this.deps.ctx.userId, roles: this.deps.ctx.roles },
      statementsPreparedBy: preparedBy,
      filingReceiptDocumentId: receipt,
      ...(controlsOk !== undefined ? { controlsOk } : {}),
    });
    if (!check.ok) throw new ClosingError(check.code, check.message, failedControls.length > 0 ? { controls: failedControls } : undefined);
    if (to === "VERROUILLE" && receipt) {
      const doc = await this.tx(async (tx) => tx`SELECT id FROM document WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${receipt}`);
      if (doc.length === 0) throw new ClosingError("RECEIPT_REQUIRED", "Accusé de dépôt introuvable dans les pièces du dossier");
    }
    const entry: WorkflowHistoryEntry = { from: wf.state, to, by: this.deps.ctx.userId, at: this.now().toISOString(), comment: opts.comment ?? null };
    const updated = await this.tx(async (tx) => {
      const [row] = await tx`
        UPDATE fiscal_year_workflow
           SET state = ${to}, history = history || ${tx.json(entry as never)}::jsonb,
               reviewer_id = ${to === "VISA" ? this.deps.ctx.userId : wf.reviewerId},
               approver_id = ${to === "DEPOT" ? this.deps.ctx.userId : to === "REVISION" ? null : wf.approverId},
               filing_receipt_document_id = ${receipt ?? null}, updated_at = ${entry.at}
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${wf.id}
         RETURNING ${workflowColumns(tx)}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'fiscal_year.transition', 'fiscal_year_workflow', ${wf.id}, ${tx.json({ state: wf.state })}, ${tx.json({ state: to, comment: opts.comment ?? null })}, ${entry.at})`;
      return mapWorkflow(row!, fiscalYearCode);
    });
    if (to === "VERROUILLE") await this.lockFiscalYear(fiscalYearCode);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Lectures
  // ---------------------------------------------------------------------------

  /** Contrôles bloquants en échec sur les états de l'exercice (balance N, N-1 si disponible). */
  async failedBlockingControls(fiscalYearCode: string): Promise<Control[]> {
    const fy = await this.fiscalYear(fiscalYearCode);
    const previous = await this.tx(async (tx) => {
      const [r] = await tx`SELECT code FROM fiscal_year WHERE tenant_id = ${this.deps.ctx.tenantId} AND end_date < ${fy.startDate} ORDER BY end_date DESC LIMIT 1`;
      return (r?.code as string | undefined) ?? null;
    });
    const current = await this.deps.ledger.trialBalance(this.deps.ctx.tenantId, { fiscalYearCode });
    const prev = previous ? await this.deps.ledger.trialBalance(this.deps.ctx.tenantId, { fiscalYearCode: previous }) : null;
    const out = computeStatements({
      system: this.deps.system ?? "NORMAL",
      currency: this.deps.currency,
      fiscalYearCode,
      balance: current.rows,
      ...(prev ? { previousBalance: prev.rows } : {}),
    });
    return out.controls.filter((c) => c.severity === "BLOCKING" && !c.ok);
  }

  async period(periodId: Id): Promise<PeriodInfo> {
    const p = await this.tx(async (tx) => {
      const [r] = await tx`
        SELECT p.id, p.fiscal_year_id, f.code, p.start_date::text AS start_date, p.end_date::text AS end_date, p.status, (p.end_date = f.end_date) AS is_last
          FROM period p JOIN fiscal_year f ON f.id = p.fiscal_year_id
         WHERE p.tenant_id = ${this.deps.ctx.tenantId} AND p.id = ${periodId}`;
      return r ? { id: r.id as Id, fiscalYearId: r.fiscal_year_id as Id, fiscalYearCode: r.code as string, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as PeriodInfo["status"], isLast: Boolean(r.is_last) } : null;
    });
    if (!p) throw new ClosingError("NOT_FOUND", `Période ${periodId} introuvable`);
    return p;
  }

  async periods(fiscalYearCode: string): Promise<PeriodInfo[]> {
    const fy = await this.fiscalYear(fiscalYearCode);
    return this.tx(async (tx) => {
      const rows = await tx`SELECT id, start_date::text AS start_date, end_date::text AS end_date, status FROM period WHERE tenant_id = ${this.deps.ctx.tenantId} AND fiscal_year_id = ${fy.id} ORDER BY start_date`;
      return rows.map((r) => ({ id: r.id as Id, fiscalYearId: fy.id, fiscalYearCode: fy.code, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as PeriodInfo["status"], isLast: r.end_date === fy.endDate }));
    });
  }

  private async fiscalYear(code: string): Promise<FiscalYearRow> {
    const fy = await this.tx(async (tx) => {
      const [r] = await tx`SELECT id, code, start_date::text AS start_date, end_date::text AS end_date, status FROM fiscal_year WHERE tenant_id = ${this.deps.ctx.tenantId} AND code = ${code}`;
      return r ? { id: r.id as Id, code: r.code as string, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as FiscalYearRow["status"] } : null;
    });
    if (!fy) throw new ClosingError("NOT_FOUND", `Exercice ${code} introuvable`);
    return fy;
  }
}

function toPeriod(p: PeriodInfo, tenantId: Id): Period {
  return { id: p.id, tenantId, fiscalYearId: p.fiscalYearId, startDate: p.startDate, endDate: p.endDate, status: p.status };
}

function checklistColumns(tx: Sql) {
  return tx`id, tenant_id, fiscal_year_id, period_id, item_key, label, blocking, status, done_by, done_at, evidence`;
}

function mapItem(r: Record<string, unknown>): ChecklistItem {
  return {
    id: r.id as Id,
    tenantId: r.tenant_id as Id,
    fiscalYearId: r.fiscal_year_id as Id,
    periodId: (r.period_id as Id | null) ?? null,
    key: r.item_key as string,
    label: r.label as string,
    blocking: Boolean(r.blocking),
    status: r.status as ChecklistStatus,
    doneBy: (r.done_by as Id | null) ?? null,
    doneAt: r.done_at instanceof Date ? r.done_at.toISOString() : ((r.done_at as string | null) ?? null),
    evidence: (r.evidence as Record<string, unknown>) ?? {},
  };
}

function workflowColumns(tx: Sql) {
  return tx`id, tenant_id, fiscal_year_id, state, history, reviewer_id, approver_id, filing_receipt_document_id, updated_at`;
}

function mapWorkflow(r: Record<string, unknown>, fiscalYearCode: string): FiscalYearWorkflow {
  return {
    id: r.id as Id,
    tenantId: r.tenant_id as Id,
    fiscalYearId: r.fiscal_year_id as Id,
    fiscalYearCode,
    state: r.state as WorkflowState,
    history: (r.history as WorkflowHistoryEntry[]) ?? [],
    reviewerId: (r.reviewer_id as Id | null) ?? null,
    approverId: (r.approver_id as Id | null) ?? null,
    filingReceiptDocumentId: (r.filing_receipt_document_id as Id | null) ?? null,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}
