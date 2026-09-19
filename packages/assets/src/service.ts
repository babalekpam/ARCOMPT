import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import { Money, sum, type Actor, type Id, type JournalEntryInput, type JournalLineInput, type Ledger } from "@arcompt/ledger";
import { accruedPortion, computeSchedule, fiscalYearEndPattern, type SchedulePeriod } from "./schedule.js";
import {
  AssetsError,
  type AssetNoteRow,
  type AssetNotes,
  type CreateAssetInput,
  type DepreciationRow,
  type DepreciationRun,
  type DisposalResult,
  type FixedAsset,
  type UpdateAssetInput,
} from "./types.js";

export interface AssetsServiceDeps {
  db: Sql;
  ledger: Ledger;
  ctx: { tenantId: Id; userId: Id; organizationId?: Id };
  /** Devise du dossier (arrondi des dotations). */
  currency: string;
  now?: () => Date;
}

interface FiscalYearRow {
  id: Id;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
}

/** Groupes du tableau des immobilisations (notes 3A / 3C), par racine de compte. */
const NOTE_GROUPS: Array<{ group: string; label: string; prefixes: string[] }> = [
  { group: "21", label: "Immobilisations incorporelles", prefixes: ["21"] },
  { group: "22", label: "Terrains", prefixes: ["22"] },
  { group: "23", label: "Bâtiments, installations techniques et agencements", prefixes: ["23"] },
  { group: "24", label: "Matériel, mobilier et actifs biologiques", prefixes: ["24"] },
  { group: "25", label: "Avances et acomptes versés sur immobilisations", prefixes: ["25"] },
  { group: "26", label: "Titres de participation", prefixes: ["26"] },
  { group: "27", label: "Autres immobilisations financières", prefixes: ["27"] },
];

/**
 * Immobilisations : fiches, plans, dotations, cessions, note annexe.
 * Le grand livre n'est écrit qu'au travers de Ledger.post ; les tables du
 * module sont accédées sous withTenant (RLS).
 */
export class AssetsService {
  private readonly now: () => Date;

  constructor(private readonly deps: AssetsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get actor(): Actor {
    return { userId: this.deps.ctx.userId, tenantId: this.deps.ctx.tenantId };
  }

  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.deps.db, this.deps.ctx, fn);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async create(input: CreateAssetInput): Promise<FixedAsset> {
    const tenantId = this.deps.ctx.tenantId;
    const cost = Money.parse(input.cost);
    const residual = Money.parse(input.residualValue ?? "0");
    const prior = Money.parse(input.priorDepreciation ?? "0");
    const method = input.method ?? (input.category === "FINANCIERE" ? "NONE" : "LINEAR");
    if (!/^2[0-79]\d*$/.test(input.accountNumber) || input.accountNumber.startsWith("28") || input.accountNumber.startsWith("29")) {
      throw new AssetsError("INVALID_INPUT", `Compte d'immobilisation attendu (2xx hors 28/29) : ${input.accountNumber}`);
    }
    if (cost.isNegative() || residual.cmp(cost) > 0) throw new AssetsError("INVALID_INPUT", "Coût ou valeur résiduelle invalide");
    if (method !== "NONE" && !(input.durationMonths && input.durationMonths > 0)) throw new AssetsError("INVALID_INPUT", "Durée d'amortissement requise (mois)");
    const depreciationAccount = method === "NONE" ? (input.depreciationAccountNumber ?? null) : (input.depreciationAccountNumber ?? `28${input.accountNumber.slice(1)}`);
    const expenseAccount = input.expenseAccountNumber ?? "681";
    const inServiceOn = input.inServiceOn ?? input.acquiredOn;
    if (inServiceOn < input.acquiredOn) throw new AssetsError("INVALID_INPUT", "Mise en service antérieure à l'acquisition");

    const accountId = await this.tx(async (tx) => {
      const [acc] = await tx`SELECT id, postable FROM account WHERE tenant_id = ${tenantId} AND number = ${input.accountNumber}`;
      if (!acc || !acc.postable) throw new AssetsError("UNKNOWN_ACCOUNT", `Compte ${input.accountNumber} inconnu ou non imputable`);
      for (const n of [depreciationAccount, expenseAccount]) {
        if (n === null || method === "NONE") continue;
        const [a] = await tx`SELECT postable FROM account WHERE tenant_id = ${tenantId} AND number = ${n}`;
        if (!a || !a.postable) throw new AssetsError("UNKNOWN_ACCOUNT", `Compte ${n} inconnu ou non imputable`);
      }
      return acc.id as Id;
    });

    // Écriture d'acquisition facultative : 2xx (+445) D / contrepartie C.
    let acquisitionEntryId: Id | null = null;
    if (input.acquisition) {
      const acq = input.acquisition;
      const vat = acq.vat ? Money.parse(acq.vat.amount) : Money.zero();
      const journalCode = acq.journalCode ?? (acq.counterpartAccount.startsWith("52") ? "BQ" : acq.counterpartAccount.startsWith("57") ? "CA" : acq.counterpartAccount.startsWith("48") ? "AC" : "OD");
      const lines: JournalLineInput[] = [{ accountNumber: input.accountNumber, debit: cost, label: input.label }];
      if (!vat.isZero()) lines.push({ accountNumber: acq.vat?.account ?? "445", debit: vat, label: "TVA récupérable sur immobilisation", ...(acq.vat?.vatCode ? { vatCode: acq.vat.vatCode } : {}) });
      lines.push({ accountNumber: acq.counterpartAccount, credit: cost.add(vat), label: input.label, ...(acq.partnerId ? { partnerId: acq.partnerId } : {}) });
      const entry = await this.deps.ledger.post(this.actor, {
        journalCode,
        date: acq.date ?? input.acquiredOn,
        label: `Acquisition immobilisation : ${input.label}`,
        source: "PURCHASE",
        ...(acq.reference ? { reference: acq.reference } : {}),
        lines,
      });
      acquisitionEntryId = entry.id;
    }

    const asset = await this.tx(async (tx) => {
      const [row] = await tx`
        INSERT INTO fixed_asset (tenant_id, account_id, label, reference, category, account_number, depreciation_account_number, expense_account_number,
                                 acquired_on, in_service_on, cost, residual_value, method, duration_months, prorata, degressive_coefficient,
                                 prior_depreciation, acquisition_entry_id, created_by)
        VALUES (${tenantId}, ${accountId}, ${input.label}, ${input.reference ?? null}, ${input.category ?? "CORPORELLE"}, ${input.accountNumber},
                ${depreciationAccount}, ${expenseAccount}, ${input.acquiredOn}, ${inServiceOn}, ${cost.toString()}, ${residual.toString()},
                ${method}, ${method === "NONE" ? null : input.durationMonths!}, ${input.prorata ?? "DAYS"}, ${input.degressiveCoefficient ?? null},
                ${prior.toString()}, ${acquisitionEntryId}, ${this.deps.ctx.userId})
        RETURNING ${assetColumns(tx)}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after, at)
        VALUES (${tenantId}, ${this.deps.ctx.userId}, 'asset.create', 'fixed_asset', ${row!.id}, ${tx.json({ label: input.label, cost: cost.toString(), account: input.accountNumber })}, ${this.now().toISOString()})`;
      return mapAsset(row!);
    });
    return asset;
  }

  async get(id: Id): Promise<FixedAsset> {
    const asset = await this.tx(async (tx) => {
      const [row] = await tx`SELECT ${assetColumns(tx)} FROM fixed_asset WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${id}`;
      return row ? mapAsset(row) : null;
    });
    if (!asset) throw new AssetsError("NOT_FOUND", `Immobilisation ${id} introuvable`);
    return asset;
  }

  async list(opts: { includeDisposed?: boolean } = {}): Promise<FixedAsset[]> {
    return this.tx(async (tx) => {
      const rows = opts.includeDisposed
        ? await tx`SELECT ${assetColumns(tx)} FROM fixed_asset WHERE tenant_id = ${this.deps.ctx.tenantId} ORDER BY acquired_on, label`
        : await tx`SELECT ${assetColumns(tx)} FROM fixed_asset WHERE tenant_id = ${this.deps.ctx.tenantId} AND disposed_on IS NULL ORDER BY acquired_on, label`;
      return rows.map(mapAsset);
    });
  }

  async update(id: Id, patch: UpdateAssetInput): Promise<FixedAsset> {
    const current = await this.get(id);
    if (current.disposedOn) throw new AssetsError("ALREADY_DISPOSED", "Immobilisation cédée : fiche figée");
    const posted = await this.postedRows(id);
    const structural = patch.cost !== undefined || patch.method !== undefined || patch.durationMonths !== undefined || patch.acquiredOn !== undefined || patch.inServiceOn !== undefined || patch.prorata !== undefined || patch.residualValue !== undefined;
    if (posted.length > 0 && structural) throw new AssetsError("ALREADY_DEPRECIATED", "Des dotations sont déjà passées : le plan ne se modifie plus (contrepassez-les d'abord)");
    const next = {
      label: patch.label ?? current.label,
      reference: patch.reference ?? current.reference,
      category: patch.category ?? current.category,
      depreciationAccountNumber: patch.depreciationAccountNumber ?? current.depreciationAccountNumber,
      expenseAccountNumber: patch.expenseAccountNumber ?? current.expenseAccountNumber,
      acquiredOn: patch.acquiredOn ?? current.acquiredOn,
      inServiceOn: patch.inServiceOn ?? current.inServiceOn,
      cost: patch.cost !== undefined ? Money.parse(patch.cost) : current.cost,
      residualValue: patch.residualValue !== undefined ? Money.parse(patch.residualValue) : current.residualValue,
      method: patch.method ?? current.method,
      durationMonths: patch.durationMonths ?? current.durationMonths,
      prorata: patch.prorata ?? current.prorata,
      degressiveCoefficient: patch.degressiveCoefficient ?? current.degressiveCoefficient,
      priorDepreciation: patch.priorDepreciation !== undefined ? Money.parse(patch.priorDepreciation) : current.priorDepreciation,
    };
    if (next.residualValue.cmp(next.cost) > 0) throw new AssetsError("INVALID_INPUT", "Valeur résiduelle supérieure au coût");
    if (next.method !== "NONE" && !(next.durationMonths && next.durationMonths > 0)) throw new AssetsError("INVALID_INPUT", "Durée d'amortissement requise (mois)");
    return this.tx(async (tx) => {
      const [row] = await tx`
        UPDATE fixed_asset
           SET label = ${next.label}, reference = ${next.reference}, category = ${next.category},
               depreciation_account_number = ${next.depreciationAccountNumber}, expense_account_number = ${next.expenseAccountNumber},
               acquired_on = ${next.acquiredOn}, in_service_on = ${next.inServiceOn}, cost = ${next.cost.toString()}, residual_value = ${next.residualValue.toString()},
               method = ${next.method}, duration_months = ${next.method === "NONE" ? null : next.durationMonths}, prorata = ${next.prorata},
               degressive_coefficient = ${next.degressiveCoefficient}, prior_depreciation = ${next.priorDepreciation.toString()}
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${id}
         RETURNING ${assetColumns(tx)}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'asset.update', 'fixed_asset', ${id}, ${tx.json({ label: current.label })}, ${tx.json(patch as never)}, ${this.now().toISOString()})`;
      return mapAsset(row!);
    });
  }

  /** Supprime une fiche sans dotation ni cession ; une fiche avec écriture d'acquisition reste supprimable (l'écriture, elle, demeure). */
  async remove(id: Id): Promise<void> {
    const asset = await this.get(id);
    if (asset.disposedOn) throw new AssetsError("ALREADY_DISPOSED", "Immobilisation cédée : conservation obligatoire");
    if ((await this.postedRows(id)).length > 0) throw new AssetsError("ALREADY_DEPRECIATED", "Des dotations sont passées : la fiche ne se supprime plus");
    await this.tx(async (tx) => {
      await tx`DELETE FROM fixed_asset WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${id}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'asset.delete', 'fixed_asset', ${id}, ${tx.json({ label: asset.label })}, ${this.now().toISOString()})`;
    });
  }

  // ---------------------------------------------------------------------------
  // Plan et dotations
  // ---------------------------------------------------------------------------

  /** Plan théorique (par exercice) et dotations effectivement enregistrées. */
  async schedule(id: Id, opts: { fiscalYearEnd?: string } = {}): Promise<{ asset: FixedAsset; plan: SchedulePeriod[]; posted: DepreciationRow[] }> {
    const asset = await this.get(id);
    const fyEnd = opts.fiscalYearEnd ?? (await this.defaultFiscalYearEnd());
    return { asset, plan: this.planFor(asset, fyEnd), posted: await this.postedRows(id) };
  }

  private planFor(asset: FixedAsset, fiscalYearEnd: string): SchedulePeriod[] {
    if (asset.method === "NONE" || !asset.durationMonths) return [];
    return computeSchedule(asset.method, {
      cost: asset.cost,
      residualValue: asset.residualValue,
      startDate: asset.inServiceOn,
      durationMonths: asset.durationMonths,
      currency: this.deps.currency,
      prorata: asset.prorata,
      fiscalYearEnd,
      ...(asset.degressiveCoefficient ? { coefficient: asset.degressiveCoefficient } : {}),
    });
  }

  /**
   * Dotations aux amortissements jusqu'à `upToDate` (défaut : fin d'exercice)
   * en UNE écriture OD (681 D / 28xx C par immobilisation). Idempotent : une
   * immobilisation déjà dotée jusqu'à cette date est ignorée ; une situation
   * intermédiaire (fin de mois) dote la part acquise depuis la dernière dotation.
   */
  async runDepreciation(fiscalYearCode: string, upToDate?: string): Promise<DepreciationRun> {
    const fy = await this.fiscalYear(fiscalYearCode);
    const upTo = upToDate ?? fy.endDate;
    if (upTo < fy.startDate || upTo > fy.endDate) throw new AssetsError("DATE_OUT_OF_RANGE", `${upTo} hors de l'exercice ${fy.code}`);
    const assets = (await this.list()).filter((a) => a.method !== "NONE" && a.inServiceOn <= upTo);
    return this.postDepreciation(fy, upTo, assets, `Dotations aux amortissements au ${upTo}`);
  }

  private async postDepreciation(fy: FiscalYearRow, upTo: string, assets: FixedAsset[], label: string): Promise<DepreciationRun> {
    const fyEnd = fiscalYearEndPattern(fy.endDate);
    const skipped: DepreciationRun["skipped"] = [];
    const pending: Array<{ asset: FixedAsset; dotation: Money; cumulative: Money; nbv: Money }> = [];
    for (const asset of assets) {
      const period = this.planFor(asset, fyEnd).find((p) => p.periodEnd === fy.endDate || (p.periodStart <= fy.endDate && p.periodEnd >= fy.startDate));
      if (!period) {
        skipped.push({ assetId: asset.id, reason: "hors plan (non commencé ou totalement amorti)" });
        continue;
      }
      const posted = await this.postedRows(asset.id);
      const lastInYear = posted.filter((r) => r.fiscalYearId === fy.id).map((r) => r.periodEnd).sort().at(-1);
      if (lastInYear && lastInYear >= upTo) {
        skipped.push({ assetId: asset.id, reason: `déjà dotée jusqu'au ${lastInYear}` });
        continue;
      }
      const target = accruedPortion(period, upTo, this.deps.currency);
      const alreadyInYear = sum(posted.filter((r) => r.fiscalYearId === fy.id).map((r) => r.dotation));
      const dotation = target.sub(alreadyInYear);
      if (!dotation.isPositive()) {
        skipped.push({ assetId: asset.id, reason: "aucune dotation due à cette date" });
        continue;
      }
      const cumulative = asset.priorDepreciation.add(sum(posted.map((r) => r.dotation))).add(dotation);
      pending.push({ asset, dotation, cumulative, nbv: asset.cost.sub(cumulative) });
    }
    if (pending.length === 0) return { fiscalYearCode: fy.code, date: upTo, entryId: null, rows: [], skipped };

    const lines: JournalLineInput[] = [];
    for (const p of pending) {
      lines.push({ accountNumber: p.asset.expenseAccountNumber, debit: p.dotation, label: `Dotation ${p.asset.label}` });
      lines.push({ accountNumber: p.asset.depreciationAccountNumber!, credit: p.dotation, label: `Amortissement ${p.asset.label}` });
    }
    const input: JournalEntryInput = { journalCode: "OD", date: upTo, label, source: "CLOSING", lines };
    const entry = await this.deps.ledger.post(this.actor, input);
    try {
      const rows = await this.tx(async (tx) => {
        const out: DepreciationRow[] = [];
        for (const p of pending) {
          const [row] = await tx`
            INSERT INTO asset_depreciation (tenant_id, asset_id, fiscal_year_id, period_end, dotation, cumulative, net_book_value, entry_id)
            VALUES (${this.deps.ctx.tenantId}, ${p.asset.id}, ${fy.id}, ${upTo}, ${p.dotation.toString()}, ${p.cumulative.toString()}, ${p.nbv.toString()}, ${entry.id})
            RETURNING id, asset_id, fiscal_year_id, period_end::text AS period_end, dotation::text AS dotation, cumulative::text AS cumulative, net_book_value::text AS net_book_value, entry_id`;
          out.push(mapRow(row!));
        }
        await tx`
          INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after, at)
          VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'asset.depreciation', 'journal_entry', ${entry.id}, ${tx.json({ date: upTo, assets: pending.length })}, ${this.now().toISOString()})`;
        return out;
      });
      return { fiscalYearCode: fy.code, date: upTo, entryId: entry.id, rows, skipped };
    } catch (e) {
      // L'écriture est validée mais le registre n'a pas suivi : on la contrepasse pour rester cohérent.
      await this.deps.ledger.reverse(this.actor, entry.id, { label: `Annulation dotations au ${upTo} (échec d'enregistrement)` });
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Cession
  // ---------------------------------------------------------------------------

  /**
   * Cession ou mise au rebut : dotation complémentaire jusqu'à la date, sortie
   * de l'actif (81x D VNC, 28xx D cumul, 2xx C coût) puis produit de cession
   * (compte de trésorerie ou 485 D / 82x C) si le prix est non nul.
   */
  async dispose(assetId: Id, date: string, price: string | Money, treasuryAccount: string, opts: { partnerId?: Id; label?: string } = {}): Promise<DisposalResult> {
    const asset = await this.get(assetId);
    if (asset.disposedOn) throw new AssetsError("ALREADY_DISPOSED", `Immobilisation déjà cédée le ${asset.disposedOn}`);
    if (date < asset.acquiredOn) throw new AssetsError("DATE_OUT_OF_RANGE", "Cession antérieure à l'acquisition");
    const salePrice = Money.parse(price);
    if (salePrice.isNegative()) throw new AssetsError("INVALID_INPUT", "Prix de cession négatif");
    const fy = await this.fiscalYearForDate(date);

    let depreciationEntryId: Id | null = null;
    if (asset.method !== "NONE") {
      const run = await this.postDepreciation(fy, date, [asset], `Dotation complémentaire jusqu'à la cession : ${asset.label}`);
      depreciationEntryId = run.entryId;
    }
    const cumulative = asset.priorDepreciation.add(sum((await this.postedRows(assetId)).map((r) => r.dotation)));
    const nbv = asset.cost.sub(cumulative);
    const [vccAccount, proceedsAccount] = asset.category === "INCORPORELLE" ? ["811", "821"] : asset.category === "FINANCIERE" ? ["816", "826"] : ["812", "822"];

    const disposalLines: JournalLineInput[] = [];
    if (nbv.isPositive()) disposalLines.push({ accountNumber: vccAccount, debit: nbv, label: `VNC ${asset.label}` });
    if (cumulative.isPositive()) disposalLines.push({ accountNumber: asset.depreciationAccountNumber!, debit: cumulative, label: `Amortissements ${asset.label}` });
    disposalLines.push({ accountNumber: asset.accountNumber, credit: asset.cost, label: `Sortie ${asset.label}` });
    const disposal = await this.deps.ledger.post(this.actor, {
      journalCode: "OD",
      date,
      label: opts.label ?? `Cession immobilisation : ${asset.label}`,
      source: "MANUAL",
      lines: disposalLines,
    });

    let proceedsEntryId: Id | null = null;
    if (salePrice.isPositive()) {
      const journalCode = treasuryAccount.startsWith("52") ? "BQ" : treasuryAccount.startsWith("57") ? "CA" : "OD";
      const proceeds = await this.deps.ledger.post(this.actor, {
        journalCode,
        date,
        label: opts.label ?? `Produit de cession : ${asset.label}`,
        source: "MANUAL",
        lines: [
          { accountNumber: treasuryAccount, debit: salePrice, label: `Cession ${asset.label}`, ...(opts.partnerId ? { partnerId: opts.partnerId } : {}) },
          { accountNumber: proceedsAccount, credit: salePrice, label: `Produit de cession ${asset.label}` },
        ],
      });
      proceedsEntryId = proceeds.id;
    }

    const updated = await this.tx(async (tx) => {
      const [row] = await tx`
        UPDATE fixed_asset SET disposed_on = ${date}, disposal_price = ${salePrice.toString()}, disposal_entry_id = ${disposal.id}, disposal_proceeds_entry_id = ${proceedsEntryId}
         WHERE tenant_id = ${this.deps.ctx.tenantId} AND id = ${assetId}
         RETURNING ${assetColumns(tx)}`;
      await tx`
        INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after, at)
        VALUES (${this.deps.ctx.tenantId}, ${this.deps.ctx.userId}, 'asset.dispose', 'fixed_asset', ${assetId}, ${tx.json({ date, price: salePrice.toString(), nbv: nbv.toString() })}, ${this.now().toISOString()})`;
      return mapAsset(row!);
    });
    return { asset: updated, depreciationEntryId, disposalEntryId: disposal.id, proceedsEntryId, netBookValue: nbv, cumulativeDepreciation: cumulative, gainLoss: salePrice.sub(nbv) };
  }

  // ---------------------------------------------------------------------------
  // Notes annexes 3A (immobilisations brutes) et 3C (amortissements)
  // ---------------------------------------------------------------------------

  async notes3A3C(fiscalYearCode: string): Promise<AssetNotes> {
    const fy = await this.fiscalYear(fiscalYearCode);
    const assets = await this.list({ includeDisposed: true });
    const rowsByAsset = await this.tx(async (tx) => {
      const rows = await tx`
        SELECT asset_id, period_end::text AS period_end, dotation::text AS dotation
          FROM asset_depreciation WHERE tenant_id = ${this.deps.ctx.tenantId}`;
      const map = new Map<Id, Array<{ periodEnd: string; dotation: Money }>>();
      for (const r of rows) {
        const list = map.get(r.asset_id as Id) ?? [];
        list.push({ periodEnd: r.period_end as string, dotation: Money.parse(r.dotation as string) });
        map.set(r.asset_id as Id, list);
      }
      return map;
    });
    const empty = (group: string, label: string): AssetNoteRow => ({
      group,
      label,
      grossOpening: Money.zero(),
      acquisitions: Money.zero(),
      disposals: Money.zero(),
      grossClosing: Money.zero(),
      depreciationOpening: Money.zero(),
      dotations: Money.zero(),
      reversals: Money.zero(),
      depreciationClosing: Money.zero(),
      netClosing: Money.zero(),
    });
    const rows = NOTE_GROUPS.map((g) => empty(g.group, g.label));
    const other = empty("2x", "Autres immobilisations");
    for (const a of assets) {
      const row = rows.find((r) => NOTE_GROUPS.find((g) => g.group === r.group)!.prefixes.some((p) => a.accountNumber.startsWith(p))) ?? other;
      const heldAtOpening = a.acquiredOn < fy.startDate && (!a.disposedOn || a.disposedOn >= fy.startDate);
      const acquiredInYear = a.acquiredOn >= fy.startDate && a.acquiredOn <= fy.endDate;
      const disposedInYear = a.disposedOn !== null && a.disposedOn >= fy.startDate && a.disposedOn <= fy.endDate;
      const dep = rowsByAsset.get(a.id) ?? [];
      const before = sum(dep.filter((d) => d.periodEnd < fy.startDate).map((d) => d.dotation));
      const inYear = sum(dep.filter((d) => d.periodEnd >= fy.startDate && d.periodEnd <= fy.endDate).map((d) => d.dotation));
      if (heldAtOpening) {
        row.grossOpening = row.grossOpening.add(a.cost);
        row.depreciationOpening = row.depreciationOpening.add(a.priorDepreciation).add(before);
      }
      if (acquiredInYear) row.acquisitions = row.acquisitions.add(a.cost);
      row.dotations = row.dotations.add(inYear);
      if (disposedInYear) {
        row.disposals = row.disposals.add(a.cost);
        row.reversals = row.reversals.add(a.priorDepreciation).add(before).add(inYear);
      }
    }
    if (!other.acquisitions.isZero() || !other.grossOpening.isZero()) rows.push(other);
    const finalize = (r: AssetNoteRow): AssetNoteRow => {
      r.grossClosing = r.grossOpening.add(r.acquisitions).sub(r.disposals);
      r.depreciationClosing = r.depreciationOpening.add(r.dotations).sub(r.reversals);
      r.netClosing = r.grossClosing.sub(r.depreciationClosing);
      return r;
    };
    const finalRows = rows.map(finalize);
    const total = empty("TOTAL", "Total");
    for (const r of finalRows) {
      total.grossOpening = total.grossOpening.add(r.grossOpening);
      total.acquisitions = total.acquisitions.add(r.acquisitions);
      total.disposals = total.disposals.add(r.disposals);
      total.depreciationOpening = total.depreciationOpening.add(r.depreciationOpening);
      total.dotations = total.dotations.add(r.dotations);
      total.reversals = total.reversals.add(r.reversals);
    }
    return { fiscalYearCode: fy.code, from: fy.startDate, to: fy.endDate, rows: finalRows, total: finalize(total) };
  }

  // ---------------------------------------------------------------------------
  // Lectures
  // ---------------------------------------------------------------------------

  async postedRows(assetId: Id): Promise<DepreciationRow[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT id, asset_id, fiscal_year_id, period_end::text AS period_end, dotation::text AS dotation, cumulative::text AS cumulative, net_book_value::text AS net_book_value, entry_id
          FROM asset_depreciation WHERE tenant_id = ${this.deps.ctx.tenantId} AND asset_id = ${assetId} ORDER BY period_end`;
      return rows.map(mapRow);
    });
  }

  private async fiscalYear(code: string): Promise<FiscalYearRow> {
    const fy = await this.tx(async (tx) => {
      const [r] = await tx`SELECT id, code, start_date::text AS start_date, end_date::text AS end_date, status FROM fiscal_year WHERE tenant_id = ${this.deps.ctx.tenantId} AND code = ${code}`;
      return r ? { id: r.id as Id, code: r.code as string, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as string } : null;
    });
    if (!fy) throw new AssetsError("FISCAL_YEAR_NOT_FOUND", `Exercice ${code} introuvable`);
    return fy;
  }

  private async fiscalYearForDate(date: string): Promise<FiscalYearRow> {
    const fy = await this.tx(async (tx) => {
      const [r] = await tx`SELECT id, code, start_date::text AS start_date, end_date::text AS end_date, status FROM fiscal_year WHERE tenant_id = ${this.deps.ctx.tenantId} AND ${date}::date BETWEEN start_date AND end_date`;
      return r ? { id: r.id as Id, code: r.code as string, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as string } : null;
    });
    if (!fy) throw new AssetsError("FISCAL_YEAR_NOT_FOUND", `Aucun exercice pour la date ${date}`);
    return fy;
  }

  /** Fin d'exercice « MM-JJ » du dossier, déduite du dernier exercice (défaut 12-31). */
  private async defaultFiscalYearEnd(): Promise<string> {
    return this.tx(async (tx) => {
      const [r] = await tx`SELECT end_date::text AS end_date FROM fiscal_year WHERE tenant_id = ${this.deps.ctx.tenantId} ORDER BY start_date DESC LIMIT 1`;
      return r ? fiscalYearEndPattern(r.end_date as string) : "12-31";
    });
  }
}

function assetColumns(tx: Sql) {
  return tx`id, tenant_id, label, reference, category, account_number, depreciation_account_number, expense_account_number,
    acquired_on::text AS acquired_on, in_service_on::text AS in_service_on, cost::text AS cost, residual_value::text AS residual_value,
    method, duration_months, prorata, degressive_coefficient::text AS degressive_coefficient, prior_depreciation::text AS prior_depreciation,
    disposed_on::text AS disposed_on, disposal_price::text AS disposal_price, acquisition_entry_id, disposal_entry_id, disposal_proceeds_entry_id, created_at`;
}

function mapAsset(r: Record<string, unknown>): FixedAsset {
  return {
    id: r.id as Id,
    tenantId: r.tenant_id as Id,
    label: r.label as string,
    reference: (r.reference as string | null) ?? null,
    category: r.category as FixedAsset["category"],
    accountNumber: r.account_number as string,
    depreciationAccountNumber: (r.depreciation_account_number as string | null) ?? null,
    expenseAccountNumber: r.expense_account_number as string,
    acquiredOn: r.acquired_on as string,
    inServiceOn: (r.in_service_on as string | null) ?? (r.acquired_on as string),
    cost: Money.parse(r.cost as string),
    residualValue: Money.parse(r.residual_value as string),
    method: r.method as FixedAsset["method"],
    durationMonths: r.duration_months === null ? null : Number(r.duration_months),
    prorata: r.prorata as FixedAsset["prorata"],
    degressiveCoefficient: r.degressive_coefficient === null ? null : trimRate(String(r.degressive_coefficient)),
    priorDepreciation: Money.parse(r.prior_depreciation as string),
    disposedOn: (r.disposed_on as string | null) ?? null,
    disposalPrice: r.disposal_price === null || r.disposal_price === undefined ? null : Money.parse(r.disposal_price as string),
    acquisitionEntryId: (r.acquisition_entry_id as Id | null) ?? null,
    disposalEntryId: (r.disposal_entry_id as Id | null) ?? null,
    disposalProceedsEntryId: (r.disposal_proceeds_entry_id as Id | null) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function mapRow(r: Record<string, unknown>): DepreciationRow {
  return {
    id: r.id as Id,
    assetId: r.asset_id as Id,
    fiscalYearId: r.fiscal_year_id as Id,
    periodEnd: r.period_end as string,
    dotation: Money.parse(r.dotation as string),
    cumulative: Money.parse(r.cumulative as string),
    netBookValue: Money.parse(r.net_book_value as string),
    entryId: (r.entry_id as Id | null) ?? null,
  };
}

/** « 1.5000 » → « 1.5 » (numeric(6,4) renvoyé en chaîne). */
function trimRate(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
