// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { Money, sum } from "@arcompt/ledger";
import { buildEntry, type EventLine, type PostingEvent } from "@arcompt/posting";
import { BaseService, InvoicingError, assertDate, dateText, isoText, money } from "../base.js";
import { Quantity, mulDivRound } from "./quantity.js";
import {
  StockValuationError,
  replayValuation,
  unitCostOf,
  valueCountedQuantity,
  valueFromUnitCost,
  type ValuationMethod,
  type ValuationMovement,
  type ValuationState,
} from "./valuation.js";
import {
  STOCK_CATEGORY_ACCOUNTS,
  type CreateStockArticleInput,
  type CreateStockCountInput,
  type MovementReason,
  type RecordMovementInput,
  type StockArticle,
  type StockCategory,
  type StockClosing,
  type StockClosingLine,
  type StockCount,
  type StockCountLine,
  type StockMovement,
  type StockPosition,
  type UpdateStockArticleInput,
} from "./types.js";

/**
 * Variation de stock par défaut d'un compte de classe 3 qui n'est porté par
 * aucun article : la racine à deux chiffres suffit à la déterminer, sauf pour
 * le 38 (stocks en cours de route) dont la nature dépend du bien transporté.
 */
const VARIATION_BY_ROOT: Record<string, string> = {
  "31": "6031",
  "32": "6032",
  "33": "6033",
  "34": "734",
  "35": "735",
  "36": "736",
  "37": "737",
};

interface FiscalYearRow {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
}

/**
 * Stocks — inventaire intermittent (SYSCOHADA révisé).
 *
 * Ce que le module fait :
 *   * un catalogue d'articles stockés, chacun avec son unité, sa méthode
 *     d'évaluation (CUMP ou PEPS) et son couple de comptes 3xx / 603x–73x ;
 *   * des mouvements d'entrée et de sortie, valorisés mais NON comptabilisés —
 *     c'est la définition même de l'inventaire intermittent : les achats sont
 *     déjà en charges (601, 602, 604…) par le module achats, et les
 *     comptabiliser une seconde fois doublerait la charge ;
 *   * un inventaire physique daté, valorisé article par article ;
 *   * à la clôture, et seulement là, deux écritures produites par le moteur
 *     d'imputation : annulation du stock initial puis constatation du stock
 *     final. Le module n'écrit jamais dans le grand livre lui-même.
 *
 * Ce que le module ne fait pas : l'inventaire permanent. Aucun mouvement ne
 * porte d'écriture, et `stock_movement.entry_id` reste NULL.
 */
export class StockService extends BaseService {
  // ---------------------------------------------------------------------------
  // Articles
  // ---------------------------------------------------------------------------

  async createArticle(input: CreateStockArticleInput): Promise<StockArticle> {
    const defaults = STOCK_CATEGORY_ACCOUNTS[input.category];
    if (!defaults) throw new InvoicingError("VALIDATION", `Catégorie de stock inconnue : ${input.category}`);
    const stockAccount = input.stockAccountNumber ?? defaults.stockAccountNumber;
    const variationAccount = input.variationAccountNumber ?? defaults.variationAccountNumber;
    if (!/^3[1-8]\d{0,11}$/.test(stockAccount)) throw new InvoicingError("VALIDATION", `Compte de stock attendu (31x–38x) : ${stockAccount}`);
    if (!/^(603[1-3]|73[4-7])\d{0,9}$/.test(variationAccount)) {
      throw new InvoicingError("VALIDATION", `Compte de variation attendu (6031–6033 ou 734–737) : ${variationAccount}`);
    }
    return this.tx(async (tx) => {
      await this.assertPostable(tx, stockAccount);
      await this.assertPostable(tx, variationAccount);
      const [row] = await tx`
        INSERT INTO stock_article (tenant_id, code, label, unit, category, stock_account_number, variation_account_number, valuation_method, product_id, active, created_by)
        VALUES (${this.tenantId}, ${input.code}, ${input.label}, ${input.unit ?? "u"}, ${input.category}, ${stockAccount}, ${variationAccount},
                ${input.valuationMethod ?? "CUMP"}, ${input.productId ?? null}, ${input.active ?? true}, ${this.ctx.userId})
        RETURNING ${articleColumns(tx)}`;
      await this.audit(tx, "stock.article.create", "stock_article", row!.id as string, { code: input.code, stockAccount, variationAccount });
      return mapArticle(row!);
    }).catch(rethrowDuplicate(`Article de stock « ${input.code} » déjà déclaré`));
  }

  async listArticles(opts: { includeInactive?: boolean } = {}): Promise<StockArticle[]> {
    return this.tx(async (tx) => {
      const rows = opts.includeInactive
        ? await tx`SELECT ${articleColumns(tx)} FROM stock_article WHERE tenant_id = ${this.tenantId} ORDER BY code`
        : await tx`SELECT ${articleColumns(tx)} FROM stock_article WHERE tenant_id = ${this.tenantId} AND active ORDER BY code`;
      return rows.map(mapArticle);
    });
  }

  async getArticle(id: string): Promise<StockArticle> {
    return this.tx((tx) => this.loadArticle(tx, id));
  }

  async updateArticle(id: string, patch: UpdateStockArticleInput): Promise<StockArticle> {
    return this.tx(async (tx) => {
      const current = await this.loadArticle(tx, id);
      // Changer de méthode ou de compte quand des mouvements existent réécrirait
      // l'histoire : l'évaluation passée deviendrait incohérente avec les
      // écritures déjà passées. Refus explicite plutôt que dérive silencieuse.
      const structural =
        (patch.valuationMethod !== undefined && patch.valuationMethod !== current.valuationMethod) ||
        (patch.stockAccountNumber !== undefined && patch.stockAccountNumber !== current.stockAccountNumber) ||
        (patch.variationAccountNumber !== undefined && patch.variationAccountNumber !== current.variationAccountNumber);
      if (structural) {
        const [{ n }] = (await tx`SELECT count(*)::int AS n FROM stock_movement WHERE tenant_id = ${this.tenantId} AND article_id = ${id}`) as [{ n: number }];
        if (n > 0) throw new InvoicingError("INVALID_STATUS", "Des mouvements existent : méthode d'évaluation et comptes figés (créez un nouvel article)");
      }
      const next = {
        label: patch.label ?? current.label,
        unit: patch.unit ?? current.unit,
        stockAccountNumber: patch.stockAccountNumber ?? current.stockAccountNumber,
        variationAccountNumber: patch.variationAccountNumber ?? current.variationAccountNumber,
        valuationMethod: patch.valuationMethod ?? current.valuationMethod,
        productId: patch.productId ?? current.productId,
        active: patch.active ?? current.active,
      };
      if (structural) {
        await this.assertPostable(tx, next.stockAccountNumber);
        await this.assertPostable(tx, next.variationAccountNumber);
      }
      const [row] = await tx`
        UPDATE stock_article SET label = ${next.label}, unit = ${next.unit}, stock_account_number = ${next.stockAccountNumber},
               variation_account_number = ${next.variationAccountNumber}, valuation_method = ${next.valuationMethod},
               product_id = ${next.productId}, active = ${next.active}
         WHERE tenant_id = ${this.tenantId} AND id = ${id}
         RETURNING ${articleColumns(tx)}`;
      await this.audit(tx, "stock.article.update", "stock_article", id, patch, { label: current.label });
      return mapArticle(row!);
    });
  }

  // ---------------------------------------------------------------------------
  // Mouvements
  // ---------------------------------------------------------------------------

  /**
   * Enregistre un mouvement puis rejoue tout l'historique de l'article : une
   * saisie antidatée change la valeur des sorties postérieures, et seul un rejeu
   * complet la recalcule. Tout se fait dans une transaction : si le rejeu refuse
   * (sortie supérieure au stock à un instant donné), rien n'est enregistré.
   */
  async recordMovement(input: RecordMovementInput): Promise<StockMovement> {
    assertDate(input.date, "date");
    const quantity = Quantity.parse(input.quantity);
    if (!quantity.isPositive()) throw new InvoicingError("VALIDATION", "quantity : quantité strictement positive attendue (le sens vient de kind)");
    const isIn = input.kind === "IN" || input.kind === "OPENING";
    if (!isIn && (input.unitCost !== undefined || input.value !== undefined)) {
      throw new InvoicingError("VALIDATION", "Une sortie ne porte pas de coût : sa valeur est calculée par la méthode d'évaluation de l'article");
    }
    if (isIn && input.unitCost === undefined && input.value === undefined) {
      throw new InvoicingError("VALIDATION", "Une entrée doit porter son coût unitaire (unitCost) ou sa valeur totale (value)");
    }
    const unitCost = input.unitCost === undefined ? null : money(input.unitCost);
    const value = isIn ? (input.value !== undefined ? money(input.value) : valueFromUnitCost(unitCost!, quantity)) : Money.zero();
    if (value.isNegative()) throw new InvoicingError("VALIDATION", "value : valeur d'entrée négative");

    return this.tx(async (tx) => {
      const article = await this.loadArticle(tx, input.articleId);
      await this.assertNotClosed(tx, input.date);
      const reason: MovementReason = input.reason ?? (input.kind === "OPENING" ? "OPENING" : isIn ? "PURCHASE" : "CONSUMPTION");
      const [row] = await tx`
        INSERT INTO stock_movement (tenant_id, article_id, movement_date, kind, reason, quantity, unit_cost, value, quantity_after, value_after,
                                    reference, note, purchase_document_id, sales_document_id, created_by)
        VALUES (${this.tenantId}, ${article.id}, ${input.date}, ${input.kind}, ${reason}, ${quantity.toString()},
                ${unitCost === null ? null : unitCost.toString()}, ${value.toString()}, 0, 0,
                ${input.reference ?? null}, ${input.note ?? null}, ${input.purchaseDocumentId ?? null}, ${input.salesDocumentId ?? null}, ${this.ctx.userId})
        RETURNING id`;
      const movementId = row!.id as string;
      await this.replayArticle(tx, article);
      await this.audit(tx, "stock.movement.record", "stock_movement", movementId, { articleId: article.id, kind: input.kind, quantity: quantity.toString(), date: input.date });
      const [saved] = await tx`SELECT ${movementColumns(tx)} FROM stock_movement WHERE tenant_id = ${this.tenantId} AND id = ${movementId}`;
      return mapMovement(saved!);
    });
  }

  async listMovements(filter: { articleId?: string; from?: string; to?: string } = {}): Promise<StockMovement[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT ${movementColumns(tx)} FROM stock_movement
         WHERE tenant_id = ${this.tenantId}
           ${filter.articleId ? tx`AND article_id = ${filter.articleId}` : tx``}
           ${filter.from ? tx`AND movement_date >= ${filter.from}` : tx``}
           ${filter.to ? tx`AND movement_date <= ${filter.to}` : tx``}
         ORDER BY movement_date, seq`;
      return rows.map(mapMovement);
    });
  }

  /** État d'un article à une date (fin de journée). Sans date : tout l'historique. */
  async position(articleId: string, asOf?: string): Promise<StockPosition> {
    return this.tx(async (tx) => {
      const article = await this.loadArticle(tx, articleId);
      const state = await this.stateAt(tx, article, asOf);
      return toPosition(article, state, asOf ?? null);
    });
  }

  /** État de tous les articles actifs à une date : l'état du stock théorique. */
  async positions(asOf?: string): Promise<StockPosition[]> {
    return this.tx(async (tx) => {
      const articles = (await tx`SELECT ${articleColumns(tx)} FROM stock_article WHERE tenant_id = ${this.tenantId} AND active ORDER BY code`).map(mapArticle);
      const out: StockPosition[] = [];
      for (const a of articles) out.push(toPosition(a, await this.stateAt(tx, a, asOf), asOf ?? null));
      return out;
    });
  }

  // ---------------------------------------------------------------------------
  // Inventaire physique
  // ---------------------------------------------------------------------------

  /**
   * Enregistre un comptage physique en brouillon et le valorise : quantité
   * théorique et valeur théorique à la date, quantité comptée, coût unitaire
   * retenu (méthode de l'article, ou saisie quand l'article n'a pas
   * d'historique) et écart d'inventaire.
   */
  async createCount(input: CreateStockCountInput): Promise<StockCount> {
    assertDate(input.date, "date");
    if (input.lines.length === 0) throw new InvoicingError("VALIDATION", "Un inventaire comporte au moins une ligne");
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.articleId)) throw new InvoicingError("VALIDATION", `Article ${l.articleId} compté deux fois dans le même inventaire`);
      seen.add(l.articleId);
    }
    return this.tx(async (tx) => {
      const fy = await this.fiscalYear(tx, input.fiscalYearCode);
      if (input.date < fy.startDate || input.date > fy.endDate) {
        throw new InvoicingError("VALIDATION", `Date ${input.date} hors de l'exercice ${fy.code} (${fy.startDate} → ${fy.endDate})`);
      }
      await this.assertNotClosed(tx, input.date);
      const [head] = await tx`
        INSERT INTO stock_count (tenant_id, fiscal_year_id, count_date, label, created_by)
        VALUES (${this.tenantId}, ${fy.id}, ${input.date}, ${input.label ?? `Inventaire au ${input.date}`}, ${this.ctx.userId})
        RETURNING id`;
      const countId = head!.id as string;

      let total = Money.zero();
      for (const line of input.lines) {
        const article = await this.loadArticle(tx, line.articleId);
        const state = await this.stateAt(tx, article, input.date);
        const counted = Quantity.parse(line.countedQuantity);
        if (counted.isNegative()) throw new InvoicingError("VALIDATION", `Article ${article.code} : quantité comptée négative`);
        const manual = line.unitCost !== undefined ? money(line.unitCost) : null;
        let value: Money;
        if (manual) {
          value = valueFromUnitCost(manual, counted);
        } else {
          try {
            value = valueCountedQuantity(state, counted);
          } catch (e) {
            if (e instanceof StockValuationError) {
              throw new InvoicingError("VALIDATION", `Article ${article.code} : ${e.message}`, { articleId: article.id, code: e.code });
            }
            throw e;
          }
        }
        const unitCost = manual ?? (counted.isPositive() ? Money.fromMinor(mulDivRound(value.minor, 10n ** 4n, counted.minor)) : null);
        total = total.add(value);
        await tx`
          INSERT INTO stock_count_line (tenant_id, count_id, article_id, counted_quantity, theoretical_quantity, theoretical_value, unit_cost, unit_cost_source, value, note)
          VALUES (${this.tenantId}, ${countId}, ${article.id}, ${counted.toString()}, ${state.quantity.toString()}, ${state.value.toString()},
                  ${unitCost === null ? null : unitCost.toString()}, ${manual ? "MANUAL" : "VALUATION"}, ${value.toString()}, ${line.note ?? null})`;
      }
      await tx`UPDATE stock_count SET total_value = ${total.toString()} WHERE tenant_id = ${this.tenantId} AND id = ${countId}`;
      await this.audit(tx, "stock.count.create", "stock_count", countId, { date: input.date, lines: input.lines.length, total: total.toString() });
      return this.readCount(tx, countId);
    });
  }

  async getCount(id: string): Promise<StockCount> {
    return this.tx((tx) => this.readCount(tx, id));
  }

  async listCounts(filter: { fiscalYearCode?: string } = {}): Promise<StockCount[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT c.id FROM stock_count c JOIN fiscal_year f ON f.id = c.fiscal_year_id
         WHERE c.tenant_id = ${this.tenantId} ${filter.fiscalYearCode ? tx`AND f.code = ${filter.fiscalYearCode}` : tx``}
         ORDER BY c.count_date DESC, c.created_at DESC`;
      const out: StockCount[] = [];
      for (const r of rows) out.push(await this.readCount(tx, r.id as string));
      return out;
    });
  }

  /**
   * Valide un inventaire. Avec `adjust`, l'écart est régularisé : un mouvement
   * d'ajustement par ligne aligne le stock théorique sur le comptage. Cela ne
   * produit AUCUNE écriture — en inventaire intermittent, c'est la valorisation
   * du comptage qui entre au bilan à la clôture, pas l'ajustement lui-même.
   */
  async validateCount(id: string, opts: { adjust?: boolean } = {}): Promise<StockCount> {
    return this.tx(async (tx) => {
      const count = await this.readCount(tx, id);
      if (count.status === "VALIDATED") throw new InvoicingError("INVALID_STATUS", "Inventaire déjà validé");
      await this.assertNotClosed(tx, count.date);
      if (opts.adjust) {
        for (const line of count.lines) {
          if (line.varianceQuantity.isZero()) continue;
          const article = await this.loadArticle(tx, line.articleId);
          const positive = line.varianceQuantity.isPositive();
          const quantity = line.varianceQuantity.abs();
          // Entrée : la valeur de l'écart est ce qui manque pour atteindre la
          // valeur comptée. Sortie : la méthode de l'article la calcule.
          const value = positive ? maxZero(line.value.sub(line.theoreticalValue)) : Money.zero();
          await tx`
            INSERT INTO stock_movement (tenant_id, article_id, movement_date, kind, reason, quantity, value, quantity_after, value_after, stock_count_id, note, created_by)
            VALUES (${this.tenantId}, ${article.id}, ${count.date}, ${positive ? "IN" : "OUT"}, 'COUNT_ADJUSTMENT', ${quantity.toString()},
                    ${value.toString()}, 0, 0, ${id}, ${`Écart d'inventaire ${count.label}`}, ${this.ctx.userId})`;
          await this.replayArticle(tx, article);
        }
      }
      await tx`
        UPDATE stock_count SET status = 'VALIDATED', adjusted = ${opts.adjust === true}, validated_by = ${this.ctx.userId}, validated_at = ${this.now().toISOString()}
         WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await this.audit(tx, "stock.count.validate", "stock_count", id, { adjusted: opts.adjust === true, total: count.totalValue.toString() });
      return this.readCount(tx, id);
    });
  }

  // ---------------------------------------------------------------------------
  // Variation de stock de fin d'exercice
  // ---------------------------------------------------------------------------

  /**
   * Passe la variation de stock de l'exercice, en inventaire intermittent.
   *
   *   1. Annulation du stock initial : 603x / 73x D à 3xx C, pour le solde
   *      débiteur de chaque compte de stock avant la clôture (les à-nouveaux).
   *   2. Constatation du stock final : 3xx D à 603x / 73x C, pour la
   *      valorisation de l'inventaire physique.
   *
   * Après quoi le compte 3xx porte exactement l'inventaire (poste BB du bilan)
   * et le compte 603x porte SI − SF, de sorte que le poste RB du compte de
   * résultat (« -6031 », soit C − D) vaut SF − SI : la variation de stock.
   *
   * Un exercice ne se clôture qu'une fois (contrainte d'unicité en base).
   */
  async closeFiscalYear(fiscalYearCode: string, opts: { countId?: string; date?: string } = {}): Promise<StockClosing> {
    const prepared = await this.tx(async (tx) => {
      const fy = await this.fiscalYear(tx, fiscalYearCode);
      const [existing] = await tx`SELECT id FROM stock_closing WHERE tenant_id = ${this.tenantId} AND fiscal_year_id = ${fy.id}`;
      if (existing) throw new InvoicingError("INVALID_STATUS", `Variation de stock déjà passée pour l'exercice ${fy.code}`);
      const date = opts.date ?? fy.endDate;
      assertDate(date, "date");
      if (date < fy.startDate || date > fy.endDate) throw new InvoicingError("VALIDATION", `Date ${date} hors de l'exercice ${fy.code}`);
      await this.assertOpenPeriod(tx, date);

      const count = await this.pickCount(tx, fy, opts.countId);
      // Stock final par compte : somme des lignes d'inventaire des articles.
      const closingByAccount = new Map<string, { variation: string; value: Money }>();
      for (const line of count.lines) {
        const article = await this.loadArticle(tx, line.articleId);
        const current = closingByAccount.get(article.stockAccountNumber);
        if (current && current.variation !== article.variationAccountNumber) {
          throw new InvoicingError("VALIDATION", `Compte de stock ${article.stockAccountNumber} rattaché à deux comptes de variation (${current.variation} et ${article.variationAccountNumber})`);
        }
        closingByAccount.set(article.stockAccountNumber, {
          variation: article.variationAccountNumber,
          value: (current?.value ?? Money.zero()).add(line.value),
        });
      }
      return { fy, date, count, closingByAccount };
    });

    const { fy, date, count, closingByAccount } = prepared;

    // Stock initial : solde débiteur des comptes de classe 3 au grand livre,
    // avant nos écritures. En inventaire intermittent, aucun mouvement n'ayant
    // été comptabilisé dans l'année, ce solde est exactement le stock initial.
    const balance = await this.deps.ledger.trialBalance(this.tenantId, { fiscalYearCode: fy.code, from: fy.startDate, to: date });
    const openingByAccount = new Map<string, Money>();
    for (const row of balance.rows) {
      if (!/^3[1-8]/.test(row.accountNumber)) continue;
      const net = row.debit.sub(row.credit);
      if (net.isZero()) continue;
      if (net.isNegative()) throw new InvoicingError("VALIDATION", `Compte de stock ${row.accountNumber} créditeur (${net}) : corrigez le grand livre avant la clôture`);
      openingByAccount.set(row.accountNumber, net);
    }

    const accounts = [...new Set([...openingByAccount.keys(), ...closingByAccount.keys()])].sort();
    const lines: StockClosingLine[] = accounts.map((accountNumber) => {
      const closing = closingByAccount.get(accountNumber);
      const variationAccount = closing?.variation ?? VARIATION_BY_ROOT[accountNumber.slice(0, 2)];
      if (!variationAccount) {
        throw new InvoicingError(
          "VALIDATION",
          `Compte de stock ${accountNumber} sans compte de variation : déclarez un article portant ce compte pour fixer sa contrepartie`,
          { accountNumber },
        );
      }
      const openingValue = openingByAccount.get(accountNumber) ?? Money.zero();
      const closingValue = closing?.value ?? Money.zero();
      return { stockAccountNumber: accountNumber, variationAccountNumber: variationAccount, openingValue, closingValue, variation: closingValue.sub(openingValue) };
    });

    const toEventLine = (l: StockClosingLine, amount: Money): EventLine => ({
      label: `${l.stockAccountNumber}`,
      amount,
      accountNumber: l.stockAccountNumber,
      counterAccountNumber: l.variationAccountNumber,
    });

    const posted: { openingEntryId: string | null; closingEntryId: string | null } = { openingEntryId: null, closingEntryId: null };
    const openingLines = lines.filter((l) => l.openingValue.isPositive()).map((l) => toEventLine(l, l.openingValue));
    if (openingLines.length > 0) {
      const event: PostingEvent = {
        kind: "STOCK_OPENING_REVERSAL",
        date,
        label: `Annulation des stocks initiaux — exercice ${fy.code}`,
        currency: this.deps.currency,
        lines: openingLines,
      };
      posted.openingEntryId = (await this.deps.ledger.post(this.actor, buildEntry(event, this.template(event.kind), this.postingContext()))).id;
    }
    const closingLines = lines.filter((l) => l.closingValue.isPositive()).map((l) => toEventLine(l, l.closingValue));
    if (closingLines.length > 0) {
      const event: PostingEvent = {
        kind: "STOCK_CLOSING",
        date,
        label: `Constatation des stocks finals — exercice ${fy.code}`,
        currency: this.deps.currency,
        lines: closingLines,
      };
      try {
        posted.closingEntryId = (await this.deps.ledger.post(this.actor, buildEntry(event, this.template(event.kind), this.postingContext()))).id;
      } catch (e) {
        // La première écriture est validée mais la seconde n'est pas passée :
        // laisser l'exercice avec les stocks initiaux annulés et rien en face
        // fausserait le résultat. On contrepasse.
        if (posted.openingEntryId) await this.deps.ledger.reverse(this.actor, posted.openingEntryId, { label: `Annulation de la clôture des stocks ${fy.code} (échec)` });
        throw e;
      }
    }

    try {
      return await this.tx(async (tx) => {
        const [head] = await tx`
          INSERT INTO stock_closing (tenant_id, fiscal_year_id, closing_date, count_id, opening_entry_id, closing_entry_id, created_by)
          VALUES (${this.tenantId}, ${fy.id}, ${date}, ${count.id}, ${posted.openingEntryId}, ${posted.closingEntryId}, ${this.ctx.userId})
          RETURNING id, created_at`;
        const closingId = head!.id as string;
        for (const l of lines) {
          await tx`
            INSERT INTO stock_closing_line (tenant_id, closing_id, stock_account_number, variation_account_number, opening_value, closing_value, variation)
            VALUES (${this.tenantId}, ${closingId}, ${l.stockAccountNumber}, ${l.variationAccountNumber}, ${l.openingValue.toString()}, ${l.closingValue.toString()}, ${l.variation.toString()})`;
        }
        await this.audit(tx, "stock.closing", "stock_closing", closingId, {
          fiscalYear: fy.code,
          date,
          opening: sum(lines.map((l) => l.openingValue)).toString(),
          closing: sum(lines.map((l) => l.closingValue)).toString(),
        });
        return {
          id: closingId,
          tenantId: this.tenantId,
          fiscalYearCode: fy.code,
          closingDate: date,
          countId: count.id,
          openingEntryId: posted.openingEntryId,
          closingEntryId: posted.closingEntryId,
          lines,
          createdAt: isoText(head!.created_at),
        };
      });
    } catch (e) {
      // Écritures passées mais registre non écrit : contrepasser pour rester cohérent.
      if (posted.closingEntryId) await this.deps.ledger.reverse(this.actor, posted.closingEntryId, { label: `Annulation de la clôture des stocks ${fy.code} (échec d'enregistrement)` });
      if (posted.openingEntryId) await this.deps.ledger.reverse(this.actor, posted.openingEntryId, { label: `Annulation de la clôture des stocks ${fy.code} (échec d'enregistrement)` });
      // Deux clôtures lancées en même temps : la contrainte d'unicité a tranché,
      // et les écritures de la perdante viennent d'être contrepassées.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
        throw new InvoicingError("INVALID_STATUS", `Variation de stock déjà passée pour l'exercice ${fy.code}`);
      }
      throw e;
    }
  }

  async getClosing(fiscalYearCode: string): Promise<StockClosing | null> {
    return this.tx(async (tx) => {
      const [head] = await tx`
        SELECT c.id, c.closing_date::text AS closing_date, c.count_id, c.opening_entry_id, c.closing_entry_id, c.created_at, f.code
          FROM stock_closing c JOIN fiscal_year f ON f.id = c.fiscal_year_id
         WHERE c.tenant_id = ${this.tenantId} AND f.code = ${fiscalYearCode}`;
      if (!head) return null;
      const rows = await tx`
        SELECT stock_account_number, variation_account_number, opening_value::text AS opening_value, closing_value::text AS closing_value, variation::text AS variation
          FROM stock_closing_line WHERE tenant_id = ${this.tenantId} AND closing_id = ${head.id} ORDER BY stock_account_number`;
      return {
        id: head.id as string,
        tenantId: this.tenantId,
        fiscalYearCode: head.code as string,
        closingDate: head.closing_date as string,
        countId: (head.count_id as string | null) ?? null,
        openingEntryId: (head.opening_entry_id as string | null) ?? null,
        closingEntryId: (head.closing_entry_id as string | null) ?? null,
        lines: rows.map((r) => ({
          stockAccountNumber: r.stock_account_number as string,
          variationAccountNumber: r.variation_account_number as string,
          openingValue: money(r.opening_value),
          closingValue: money(r.closing_value),
          variation: money(r.variation),
        })),
        createdAt: isoText(head.created_at),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  private async loadArticle(tx: Sql, id: string): Promise<StockArticle> {
    const [row] = await tx`SELECT ${articleColumns(tx)} FROM stock_article WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    if (!row) throw new InvoicingError("NOT_FOUND", `Article de stock ${id} introuvable`);
    return mapArticle(row);
  }

  private async assertPostable(tx: Sql, number: string): Promise<void> {
    const [a] = await tx`SELECT postable FROM account WHERE tenant_id = ${this.tenantId} AND number = ${number}`;
    if (!a) throw new InvoicingError("VALIDATION", `Compte ${number} absent du plan de comptes du dossier`);
    if (!a.postable) throw new InvoicingError("VALIDATION", `Compte ${number} non imputable (compte de regroupement)`);
  }

  /** Refuse toute saisie dans un exercice dont la variation de stock est déjà passée. */
  private async assertNotClosed(tx: Sql, date: string): Promise<void> {
    const [row] = await tx`
      SELECT f.code FROM stock_closing c JOIN fiscal_year f ON f.id = c.fiscal_year_id
       WHERE c.tenant_id = ${this.tenantId} AND ${date}::date BETWEEN f.start_date AND f.end_date`;
    if (row) throw new InvoicingError("PERIOD_CLOSED", `Variation de stock déjà passée pour l'exercice ${row.code} : ${date} n'accepte plus de mouvement`);
  }

  private async fiscalYear(tx: Sql, code: string): Promise<FiscalYearRow> {
    const [r] = await tx`SELECT id, code, start_date::text AS start_date, end_date::text AS end_date FROM fiscal_year WHERE tenant_id = ${this.tenantId} AND code = ${code}`;
    if (!r) throw new InvoicingError("NOT_FOUND", `Exercice ${code} introuvable`);
    return { id: r.id as string, code: r.code as string, startDate: r.start_date as string, endDate: r.end_date as string };
  }

  /** Inventaire retenu pour la clôture : celui demandé, sinon le dernier validé de l'exercice. */
  private async pickCount(tx: Sql, fy: FiscalYearRow, countId?: string): Promise<StockCount> {
    if (countId) {
      const count = await this.readCount(tx, countId);
      if (count.fiscalYearId !== fy.id) throw new InvoicingError("VALIDATION", `Inventaire ${countId} hors de l'exercice ${fy.code}`);
      if (count.status !== "VALIDATED") throw new InvoicingError("INVALID_STATUS", "L'inventaire doit être validé avant la clôture");
      return count;
    }
    const [row] = await tx`
      SELECT id FROM stock_count WHERE tenant_id = ${this.tenantId} AND fiscal_year_id = ${fy.id} AND status = 'VALIDATED'
       ORDER BY count_date DESC, created_at DESC LIMIT 1`;
    if (!row) throw new InvoicingError("VALIDATION", `Aucun inventaire validé pour l'exercice ${fy.code} : le stock final ne peut pas être constaté sans comptage`);
    return this.readCount(tx, row.id as string);
  }

  /** État d'évaluation d'un article, éventuellement arrêté à une date. */
  private async stateAt(tx: Sql, article: StockArticle, asOf?: string): Promise<ValuationState> {
    const rows = asOf
      ? await tx`SELECT id, movement_date::text AS movement_date, kind, quantity::text AS quantity, value::text AS value
                   FROM stock_movement WHERE tenant_id = ${this.tenantId} AND article_id = ${article.id} AND movement_date <= ${asOf} ORDER BY movement_date, seq`
      : await tx`SELECT id, movement_date::text AS movement_date, kind, quantity::text AS quantity, value::text AS value
                   FROM stock_movement WHERE tenant_id = ${this.tenantId} AND article_id = ${article.id} ORDER BY movement_date, seq`;
    return replayValuation(article.valuationMethod, rows.map(toValuationMovement));
  }

  /**
   * Rejoue l'article entier et réécrit la valeur des sorties ainsi que les
   * instantanés (quantité et valeur après mouvement) de chaque ligne.
   */
  private async replayArticle(tx: Sql, article: StockArticle): Promise<ValuationState> {
    const rows = await tx`
      SELECT id, movement_date::text AS movement_date, kind, quantity::text AS quantity, value::text AS value
        FROM stock_movement WHERE tenant_id = ${this.tenantId} AND article_id = ${article.id} ORDER BY movement_date, seq`;
    let state: ValuationState;
    try {
      state = replayValuation(article.valuationMethod, rows.map(toValuationMovement));
    } catch (e) {
      if (e instanceof StockValuationError) {
        throw new InvoicingError("VALIDATION", `Article ${article.code} : ${e.message}`, { articleId: article.id, code: e.code });
      }
      throw e;
    }
    for (const step of state.steps) {
      await tx`
        UPDATE stock_movement SET value = ${step.value.toString()}, quantity_after = ${step.quantityAfter.toString()}, value_after = ${step.valueAfter.toString()}
         WHERE tenant_id = ${this.tenantId} AND id = ${step.id}`;
    }
    return state;
  }

  private async readCount(tx: Sql, id: string): Promise<StockCount> {
    const [head] = await tx`
      SELECT c.id, c.fiscal_year_id, f.code AS fiscal_year_code, c.count_date::text AS count_date, c.label, c.status,
             c.total_value::text AS total_value, c.adjusted, c.validated_at, c.created_at
        FROM stock_count c JOIN fiscal_year f ON f.id = c.fiscal_year_id
       WHERE c.tenant_id = ${this.tenantId} AND c.id = ${id}`;
    if (!head) throw new InvoicingError("NOT_FOUND", `Inventaire ${id} introuvable`);
    const rows = await tx`
      SELECT l.id, l.count_id, l.article_id, a.code, a.label, a.unit, l.counted_quantity::text AS counted_quantity,
             l.theoretical_quantity::text AS theoretical_quantity, l.theoretical_value::text AS theoretical_value,
             l.unit_cost::text AS unit_cost, l.unit_cost_source, l.value::text AS value, l.note
        FROM stock_count_line l JOIN stock_article a ON a.id = l.article_id
       WHERE l.tenant_id = ${this.tenantId} AND l.count_id = ${id} ORDER BY a.code`;
    const lines: StockCountLine[] = rows.map((r) => {
      const counted = Quantity.parse(r.counted_quantity as string);
      const theoretical = Quantity.parse(r.theoretical_quantity as string);
      const value = money(r.value);
      const theoreticalValue = money(r.theoretical_value);
      return {
        id: r.id as string,
        countId: r.count_id as string,
        articleId: r.article_id as string,
        code: r.code as string,
        label: r.label as string,
        unit: r.unit as string,
        countedQuantity: counted,
        theoreticalQuantity: theoretical,
        theoreticalValue,
        unitCost: r.unit_cost === null ? null : money(r.unit_cost),
        unitCostSource: r.unit_cost_source as "VALUATION" | "MANUAL",
        value,
        varianceQuantity: counted.sub(theoretical),
        varianceValue: value.sub(theoreticalValue),
        note: (r.note as string | null) ?? null,
      };
    });
    return {
      id: head.id as string,
      tenantId: this.tenantId,
      fiscalYearId: head.fiscal_year_id as string,
      fiscalYearCode: head.fiscal_year_code as string,
      date: dateText(head.count_date),
      label: head.label as string,
      status: head.status as StockCount["status"],
      totalValue: money(head.total_value),
      adjusted: head.adjusted === true,
      validatedAt: head.validated_at === null ? null : isoText(head.validated_at),
      createdAt: isoText(head.created_at),
      lines,
    };
  }
}

// -----------------------------------------------------------------------------
// Mappage
// -----------------------------------------------------------------------------

function articleColumns(tx: Sql) {
  return tx`id, tenant_id, code, label, unit, category, stock_account_number, variation_account_number, valuation_method, product_id, active, created_at`;
}

function movementColumns(tx: Sql) {
  return tx`id, tenant_id, article_id, seq, movement_date::text AS movement_date, kind, reason, quantity::text AS quantity,
    unit_cost::text AS unit_cost, value::text AS value, quantity_after::text AS quantity_after, value_after::text AS value_after,
    reference, note, purchase_document_id, sales_document_id, stock_count_id, entry_id, created_at`;
}

function mapArticle(r: Record<string, unknown>): StockArticle {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    code: r.code as string,
    label: r.label as string,
    unit: r.unit as string,
    category: r.category as StockCategory,
    stockAccountNumber: r.stock_account_number as string,
    variationAccountNumber: r.variation_account_number as string,
    valuationMethod: r.valuation_method as ValuationMethod,
    productId: (r.product_id as string | null) ?? null,
    active: r.active === true,
    createdAt: isoText(r.created_at),
  };
}

function mapMovement(r: Record<string, unknown>): StockMovement {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    articleId: r.article_id as string,
    seq: Number(r.seq),
    date: dateText(r.movement_date),
    kind: r.kind as StockMovement["kind"],
    reason: r.reason as MovementReason,
    quantity: Quantity.parse(r.quantity as string),
    unitCost: r.unit_cost === null || r.unit_cost === undefined ? null : money(r.unit_cost),
    value: money(r.value),
    quantityAfter: Quantity.parse(r.quantity_after as string),
    valueAfter: money(r.value_after),
    reference: (r.reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    purchaseDocumentId: (r.purchase_document_id as string | null) ?? null,
    salesDocumentId: (r.sales_document_id as string | null) ?? null,
    stockCountId: (r.stock_count_id as string | null) ?? null,
    entryId: (r.entry_id as string | null) ?? null,
    createdAt: isoText(r.created_at),
  };
}

function toValuationMovement(r: Record<string, unknown>): ValuationMovement {
  const kind = r.kind as ValuationMovement["kind"];
  return {
    id: r.id as string,
    date: r.movement_date as string,
    kind,
    quantity: Quantity.parse(r.quantity as string),
    ...(kind === "OUT" ? {} : { value: money(r.value) }),
  };
}

function toPosition(article: StockArticle, state: ValuationState, asOf: string | null): StockPosition {
  return {
    articleId: article.id,
    code: article.code,
    label: article.label,
    unit: article.unit,
    valuationMethod: article.valuationMethod,
    stockAccountNumber: article.stockAccountNumber,
    variationAccountNumber: article.variationAccountNumber,
    quantity: state.quantity,
    value: state.value,
    unitCost: unitCostOf(state),
    asOf,
  };
}

function maxZero(m: Money): Money {
  return m.isNegative() ? Money.zero() : m;
}

/** Traduit la violation d'unicité PostgreSQL (23505) en erreur métier lisible. */
function rethrowDuplicate(message: string) {
  return (e: unknown): never => {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") throw new InvoicingError("DUPLICATE", message);
    throw e;
  };
}
