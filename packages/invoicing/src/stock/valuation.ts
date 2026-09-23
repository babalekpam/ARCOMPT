import { Money } from "@arcompt/ledger";
import { Quantity, mulDivRound } from "./quantity.js";

/**
 * Évaluation des stocks — fonction pure, aucun accès à la base.
 *
 * Deux méthodes, les deux seules que le SYSCOHADA révisé admet pour des biens
 * interchangeables : le coût unitaire moyen pondéré après chaque entrée (CUMP)
 * et le premier entré-premier sorti (PEPS, FIFO). Le dernier entré-premier
 * sorti (DEPS, LIFO) est proscrit et n'existe nulle part dans ce module.
 *
 * Aucun flottant, et aucun coût unitaire intermédiaire : l'état courant est un
 * couple (quantité, valeur) en bigint, et la valeur d'une sortie est la part
 * exacte `valeur × quantité_sortie ÷ quantité_en_stock`, arrondie une seule
 * fois. Le stock résiduel vaut donc toujours exactement ce qui reste, sans
 * dérive d'arrondi cumulée — ce qu'un coût unitaire arrondi ne garantirait pas.
 */

export type ValuationMethod = "CUMP" | "FIFO";

export type MovementKind = "OPENING" | "IN" | "OUT";

export interface ValuationMovement {
  id: string;
  date: string;
  kind: MovementKind;
  /** Toujours strictement positive : le sens vient de `kind`. */
  quantity: Quantity;
  /** Valeur de l'entrée (coût d'acquisition ou de production). Ignorée sur une sortie. */
  value?: Money;
}

export interface ValuationStep {
  id: string;
  date: string;
  kind: MovementKind;
  quantity: Quantity;
  /** Valeur du mouvement : celle fournie pour une entrée, celle calculée pour une sortie. */
  value: Money;
  quantityAfter: Quantity;
  valueAfter: Money;
}

/** Couche PEPS : un lot d'entrée non encore consommé. */
export interface ValuationLayer {
  movementId: string;
  date: string;
  quantity: Quantity;
  value: Money;
}

export interface ValuationState {
  method: ValuationMethod;
  quantity: Quantity;
  value: Money;
  /** Couches restantes, de la plus ancienne à la plus récente (PEPS seulement). */
  layers: ValuationLayer[];
  steps: ValuationStep[];
}

export type StockValuationErrorCode = "MISSING_VALUE" | "INSUFFICIENT_STOCK" | "NO_COST";

export class StockValuationError extends Error {
  override name = "StockValuationError";
  constructor(
    readonly code: StockValuationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Rejoue toute l'histoire d'un article et renvoie son état final ainsi que la
 * valeur de chaque mouvement. Les mouvements doivent être fournis dans l'ordre
 * chronologique de rejeu (date, puis ordre de saisie).
 *
 * Le rejeu complet, plutôt qu'une mise à jour incrémentale, est délibéré : une
 * saisie antidatée change la valeur des sorties postérieures, et seul un rejeu
 * la recalcule correctement.
 */
export function replayValuation(method: ValuationMethod, movements: readonly ValuationMovement[]): ValuationState {
  const state: ValuationState = { method, quantity: Quantity.zero(), value: Money.zero(), layers: [], steps: [] };

  for (const m of movements) {
    if (!m.quantity.isPositive()) {
      throw new StockValuationError("MISSING_VALUE", `Mouvement ${m.id} : quantité nulle ou négative (${m.quantity})`, { movementId: m.id });
    }
    if (m.kind === "OUT") {
      if (m.quantity.cmp(state.quantity) > 0) {
        throw new StockValuationError(
          "INSUFFICIENT_STOCK",
          `Mouvement ${m.id} du ${m.date} : sortie de ${m.quantity} pour un stock de ${state.quantity}`,
          { movementId: m.id, requested: m.quantity.toString(), available: state.quantity.toString() },
        );
      }
      const value = method === "FIFO" ? consumeFifo(state, m.quantity) : consumeAverage(state, m.quantity);
      state.quantity = state.quantity.sub(m.quantity);
      state.value = state.value.sub(value);
      state.steps.push({ id: m.id, date: m.date, kind: m.kind, quantity: m.quantity, value, quantityAfter: state.quantity, valueAfter: state.value });
      continue;
    }
    if (m.value === undefined) {
      throw new StockValuationError("MISSING_VALUE", `Mouvement ${m.id} du ${m.date} : une entrée doit porter sa valeur`, { movementId: m.id });
    }
    if (m.value.isNegative()) {
      throw new StockValuationError("MISSING_VALUE", `Mouvement ${m.id} : valeur d'entrée négative (${m.value})`, { movementId: m.id });
    }
    state.quantity = state.quantity.add(m.quantity);
    state.value = state.value.add(m.value);
    if (method === "FIFO") state.layers.push({ movementId: m.id, date: m.date, quantity: m.quantity, value: m.value });
    state.steps.push({ id: m.id, date: m.date, kind: m.kind, quantity: m.quantity, value: m.value, quantityAfter: state.quantity, valueAfter: state.value });
  }
  return state;
}

/**
 * CUMP : la sortie emporte la valeur en stock moins celle du reliquat.
 *
 * Écrit dans ce sens, et non « part proportionnelle de la sortie », pour que la
 * valeur résiduelle soit exactement celle que `valueCountedQuantity` calculerait
 * pour la quantité restante : l'écart d'arrondi (au plus 0,0001) tombe dans la
 * consommation, jamais dans le stock porté au bilan.
 */
function consumeAverage(state: ValuationState, quantity: Quantity): Money {
  if (state.quantity.isZero()) return Money.zero();
  const remainingQuantity = state.quantity.sub(quantity);
  if (remainingQuantity.isZero()) return state.value; // solde exact : aucun résidu
  const remainingValue = Money.fromMinor(mulDivRound(state.value.minor, remainingQuantity.minor, state.quantity.minor));
  return state.value.sub(remainingValue);
}

/** PEPS : la sortie consomme les couches les plus anciennes. */
function consumeFifo(state: ValuationState, quantity: Quantity): Money {
  let remaining = quantity;
  let out = Money.zero();
  while (remaining.isPositive()) {
    const layer = state.layers[0];
    if (!layer) break; // impossible : la quantité disponible a déjà été vérifiée
    if (layer.quantity.cmp(remaining) <= 0) {
      out = out.add(layer.value);
      remaining = remaining.sub(layer.quantity);
      state.layers.shift();
      continue;
    }
    const share = Money.fromMinor(mulDivRound(layer.value.minor, remaining.minor, layer.quantity.minor));
    out = out.add(share);
    layer.quantity = layer.quantity.sub(remaining);
    layer.value = layer.value.sub(share);
    remaining = Quantity.zero();
  }
  return out;
}

/** Coût unitaire du stock résiduel, pour l'affichage seulement. Null si le stock est nul. */
export function unitCostOf(state: ValuationState): Money | null {
  if (state.quantity.isZero()) return null;
  return Money.fromMinor(mulDivRound(state.value.minor, 10n ** 4n, state.quantity.minor));
}

/**
 * Valorise une quantité comptée à l'inventaire physique.
 *
 * En CUMP, la quantité comptée est valorisée au coût moyen du moment. En PEPS,
 * le stock qui reste est par construction le plus récemment entré : on le
 * valorise en remontant les couches de la plus récente vers la plus ancienne.
 *
 * Si le comptage dépasse le stock théorique, l'excédent est valorisé au coût
 * unitaire le plus récent connu — l'écart est en quantité, pas en prix.
 */
export function valueCountedQuantity(state: ValuationState, counted: Quantity): Money {
  if (counted.isZero()) return Money.zero();
  if (counted.isNegative()) throw new StockValuationError("NO_COST", `Quantité comptée négative (${counted})`);

  if (state.method === "CUMP") {
    if (state.quantity.isZero()) {
      throw new StockValuationError("NO_COST", "Aucun coût connu : stock théorique nul, un coût unitaire doit être saisi sur la ligne d'inventaire");
    }
    if (counted.eq(state.quantity)) return state.value;
    return Money.fromMinor(mulDivRound(state.value.minor, counted.minor, state.quantity.minor));
  }

  // PEPS : les couches les plus récentes d'abord.
  let remaining = counted;
  let total = Money.zero();
  let lastLayer: ValuationLayer | undefined;
  for (let i = state.layers.length - 1; i >= 0 && remaining.isPositive(); i--) {
    const layer = state.layers[i]!;
    lastLayer = layer;
    if (layer.quantity.cmp(remaining) <= 0) {
      total = total.add(layer.value);
      remaining = remaining.sub(layer.quantity);
      continue;
    }
    total = total.add(Money.fromMinor(mulDivRound(layer.value.minor, remaining.minor, layer.quantity.minor)));
    remaining = Quantity.zero();
  }
  if (remaining.isPositive()) {
    if (!lastLayer || lastLayer.quantity.isZero()) {
      throw new StockValuationError("NO_COST", "Aucune couche d'entrée connue : un coût unitaire doit être saisi sur la ligne d'inventaire");
    }
    total = total.add(Money.fromMinor(mulDivRound(lastLayer.value.minor, remaining.minor, lastLayer.quantity.minor)));
  }
  return total;
}

/** Valeur d'une entrée donnée par un coût unitaire : coût × quantité, arrondi une fois. */
export function valueFromUnitCost(unitCost: Money, quantity: Quantity): Money {
  return Money.fromMinor(mulDivRound(unitCost.minor, quantity.minor, 10n ** 4n));
}
