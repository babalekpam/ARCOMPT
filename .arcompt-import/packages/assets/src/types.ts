// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Id, Money } from "@arcompt/ledger";

export type AssetCategory = "INCORPORELLE" | "CORPORELLE" | "FINANCIERE";
export type DepreciationMethod = "LINEAR" | "DEGRESSIVE" | "NONE";
export type Prorata = "DAYS" | "MONTHS";

/** Fiche d'immobilisation (table fixed_asset). */
export interface FixedAsset {
  id: Id;
  tenantId: Id;
  label: string;
  reference: string | null;
  category: AssetCategory;
  /** Compte d'immobilisation 2xx. */
  accountNumber: string;
  /** Compte d'amortissement 28xx (null si non amortissable). */
  depreciationAccountNumber: string | null;
  /** Compte de dotation 68x. */
  expenseAccountNumber: string;
  acquiredOn: string;
  /** Début d'amortissement (mise en service). */
  inServiceOn: string;
  cost: Money;
  residualValue: Money;
  method: DepreciationMethod;
  durationMonths: number | null;
  prorata: Prorata;
  degressiveCoefficient: string | null;
  /** Amortissements antérieurs à la reprise du dossier (déjà dans la balance d'ouverture). */
  priorDepreciation: Money;
  disposedOn: string | null;
  disposalPrice: Money | null;
  acquisitionEntryId: Id | null;
  disposalEntryId: Id | null;
  disposalProceedsEntryId: Id | null;
  createdAt: string;
}

export interface AcquisitionPosting {
  /** Journal de l'écriture d'acquisition (défaut : AC si contrepartie 481, BQ si 52x, CA si 57x, sinon OD). */
  journalCode?: string;
  /** Contrepartie : 481 (fournisseur d'investissement, tiers requis), 521, 571… */
  counterpartAccount: string;
  partnerId?: Id;
  date?: string;
  reference?: string;
  /** TVA récupérable sur immobilisation (445 par défaut). */
  vat?: { amount: string; account?: string; vatCode?: string };
}

export interface CreateAssetInput {
  label: string;
  reference?: string;
  category?: AssetCategory;
  accountNumber: string;
  depreciationAccountNumber?: string;
  expenseAccountNumber?: string;
  acquiredOn: string;
  inServiceOn?: string;
  cost: string;
  residualValue?: string;
  method?: DepreciationMethod;
  durationMonths?: number;
  prorata?: Prorata;
  degressiveCoefficient?: string;
  priorDepreciation?: string;
  /** Si présent, l'écriture d'acquisition est passée dans la foulée. */
  acquisition?: AcquisitionPosting;
}

export type UpdateAssetInput = Partial<Omit<CreateAssetInput, "acquisition" | "accountNumber">>;

/** Ligne de dotation enregistrée (table asset_depreciation). */
export interface DepreciationRow {
  id: Id;
  assetId: Id;
  fiscalYearId: Id;
  periodEnd: string;
  dotation: Money;
  cumulative: Money;
  netBookValue: Money;
  entryId: Id | null;
}

export interface DepreciationRun {
  fiscalYearCode: string;
  date: string;
  /** Écriture OD unique (null si rien à passer). */
  entryId: Id | null;
  rows: DepreciationRow[];
  /** Immobilisations ignorées (déjà dotées jusqu'à la date, non amortissables, cédées…). */
  skipped: Array<{ assetId: Id; reason: string }>;
}

export interface DisposalResult {
  asset: FixedAsset;
  /** Dotation complémentaire jusqu'à la date de cession (null si aucune). */
  depreciationEntryId: Id | null;
  /** Sortie de l'actif : 81x D, 28xx D, 2xx C. */
  disposalEntryId: Id;
  /** Produit de cession : 5xx ou 485 D / 82x C (null si prix nul, mise au rebut). */
  proceedsEntryId: Id | null;
  netBookValue: Money;
  cumulativeDepreciation: Money;
  /** Plus (+) ou moins (−) value. */
  gainLoss: Money;
}

/** Une ligne du tableau des immobilisations (notes 3A / 3C). */
export interface AssetNoteRow {
  group: string;
  label: string;
  grossOpening: Money;
  acquisitions: Money;
  disposals: Money;
  grossClosing: Money;
  depreciationOpening: Money;
  dotations: Money;
  reversals: Money;
  depreciationClosing: Money;
  netClosing: Money;
}

export interface AssetNotes {
  fiscalYearCode: string;
  from: string;
  to: string;
  rows: AssetNoteRow[];
  total: AssetNoteRow;
}

export type AssetsErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "UNKNOWN_ACCOUNT"
  | "FISCAL_YEAR_NOT_FOUND"
  | "DATE_OUT_OF_RANGE"
  | "ALREADY_DISPOSED"
  | "ALREADY_DEPRECIATED";

export class AssetsError extends Error {
  override name = "AssetsError";
  constructor(
    readonly code: AssetsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
