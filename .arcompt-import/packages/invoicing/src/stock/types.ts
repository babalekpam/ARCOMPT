// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Money } from "@arcompt/ledger";
import type { Quantity } from "./quantity.js";
import type { MovementKind, ValuationMethod } from "./valuation.js";

export type { MovementKind, ValuationMethod };

/**
 * Catégorie SYSCOHADA de l'article. Elle fixe le couple de comptes par défaut :
 * compte de stock (classe 3) et compte de variation (603x pour les biens
 * achetés, 73x pour les biens et services produits).
 */
export type StockCategory = "MARCHANDISE" | "MATIERE_PREMIERE" | "AUTRE_APPRO" | "EN_COURS" | "PRODUIT_FINI" | "PRODUIT_INTERMEDIAIRE";

export interface StockCategoryAccounts {
  stockAccountNumber: string;
  variationAccountNumber: string;
  label: string;
}

/**
 * Comptes par défaut de chaque catégorie (SYSCOHADA révisé, indicatif : à
 * valider par l'expert-comptable référent). Les comptes de regroupement « 31 »
 * et « 603 » ne sont pas imputables ; on vise donc le premier compte de dernier
 * niveau du gabarit, que le dossier reste libre de remplacer.
 */
export const STOCK_CATEGORY_ACCOUNTS: Record<StockCategory, StockCategoryAccounts> = {
  MARCHANDISE: { stockAccountNumber: "311", variationAccountNumber: "6031", label: "Marchandises" },
  MATIERE_PREMIERE: { stockAccountNumber: "321", variationAccountNumber: "6032", label: "Matières premières et fournitures liées" },
  AUTRE_APPRO: { stockAccountNumber: "331", variationAccountNumber: "6033", label: "Autres approvisionnements" },
  EN_COURS: { stockAccountNumber: "341", variationAccountNumber: "734", label: "Produits en cours" },
  PRODUIT_FINI: { stockAccountNumber: "361", variationAccountNumber: "736", label: "Produits finis" },
  PRODUIT_INTERMEDIAIRE: { stockAccountNumber: "371", variationAccountNumber: "737", label: "Produits intermédiaires et résiduels" },
};

export type MovementReason =
  | "OPENING"
  | "PURCHASE"
  | "PRODUCTION"
  | "RETURN_IN"
  | "SALE"
  | "CONSUMPTION"
  | "LOSS"
  | "RETURN_OUT"
  | "COUNT_ADJUSTMENT"
  | "OTHER";

export interface StockArticle {
  id: string;
  tenantId: string;
  code: string;
  label: string;
  unit: string;
  category: StockCategory;
  stockAccountNumber: string;
  variationAccountNumber: string;
  valuationMethod: ValuationMethod;
  productId: string | null;
  active: boolean;
  createdAt: string;
}

export interface CreateStockArticleInput {
  code: string;
  label: string;
  unit?: string;
  category: StockCategory;
  stockAccountNumber?: string;
  variationAccountNumber?: string;
  valuationMethod?: ValuationMethod;
  productId?: string;
  active?: boolean;
}

export type UpdateStockArticleInput = Partial<Omit<CreateStockArticleInput, "code" | "category">>;

export interface StockMovement {
  id: string;
  tenantId: string;
  articleId: string;
  seq: number;
  date: string;
  kind: MovementKind;
  reason: MovementReason;
  quantity: Quantity;
  /** Coût unitaire saisi sur une entrée ; null sur une sortie et sur une entrée valorisée en bloc. */
  unitCost: Money | null;
  value: Money;
  quantityAfter: Quantity;
  valueAfter: Money;
  reference: string | null;
  note: string | null;
  purchaseDocumentId: string | null;
  salesDocumentId: string | null;
  stockCountId: string | null;
  /**
   * Toujours null en inventaire intermittent : un mouvement de stock n'est pas
   * comptabilisé, seule la variation de clôture l'est.
   */
  entryId: string | null;
  createdAt: string;
}

export interface RecordMovementInput {
  articleId: string;
  date: string;
  kind: MovementKind;
  reason?: MovementReason;
  quantity: string;
  /** Entrée : coût unitaire OU valeur totale, l'un des deux. Sortie : ni l'un ni l'autre. */
  unitCost?: string;
  value?: string;
  reference?: string;
  note?: string;
  purchaseDocumentId?: string;
  salesDocumentId?: string;
}

/** État d'un article à une date : quantité, valeur et coût unitaire du stock résiduel. */
export interface StockPosition {
  articleId: string;
  code: string;
  label: string;
  unit: string;
  valuationMethod: ValuationMethod;
  stockAccountNumber: string;
  variationAccountNumber: string;
  quantity: Quantity;
  value: Money;
  /** Null quand la quantité est nulle. */
  unitCost: Money | null;
  /** Date d'arrêté demandée ; null quand la position couvre tout l'historique. */
  asOf: string | null;
}

export type StockCountStatus = "DRAFT" | "VALIDATED";

export interface StockCountLine {
  id: string;
  countId: string;
  articleId: string;
  code: string;
  label: string;
  unit: string;
  countedQuantity: Quantity;
  theoreticalQuantity: Quantity;
  theoreticalValue: Money;
  unitCost: Money | null;
  unitCostSource: "VALUATION" | "MANUAL";
  value: Money;
  /** Comptée − théorique : l'écart d'inventaire, en quantité puis en valeur. */
  varianceQuantity: Quantity;
  varianceValue: Money;
  note: string | null;
}

export interface StockCount {
  id: string;
  tenantId: string;
  fiscalYearId: string;
  fiscalYearCode: string;
  date: string;
  label: string;
  status: StockCountStatus;
  totalValue: Money;
  adjusted: boolean;
  validatedAt: string | null;
  createdAt: string;
  lines: StockCountLine[];
}

export interface CreateStockCountInput {
  fiscalYearCode: string;
  date: string;
  label?: string;
  lines: Array<{ articleId: string; countedQuantity: string; unitCost?: string; note?: string }>;
}

/** Une ligne de la variation de stock de clôture, par compte de stock. */
export interface StockClosingLine {
  stockAccountNumber: string;
  variationAccountNumber: string;
  /** Solde débiteur du compte 3xx avant la clôture : le stock initial. */
  openingValue: Money;
  /** Valorisation de l'inventaire physique : le stock final. */
  closingValue: Money;
  /** closingValue − openingValue. Positif : stockage ; négatif : déstockage. */
  variation: Money;
}

export interface StockClosing {
  id: string;
  tenantId: string;
  fiscalYearCode: string;
  closingDate: string;
  countId: string | null;
  /** Annulation du stock initial (603x/73x D à 3xx C) ; null si le stock initial est nul. */
  openingEntryId: string | null;
  /** Constatation du stock final (3xx D à 603x/73x C) ; null si l'inventaire est nul. */
  closingEntryId: string | null;
  lines: StockClosingLine[];
  createdAt: string;
}
