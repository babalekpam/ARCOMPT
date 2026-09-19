/** Types des réponses de l'API immobilisations (/v1/assets), copiés du paquet serveur. Montants en chaînes décimales. */
export type AssetCategory = "INCORPORELLE" | "CORPORELLE" | "FINANCIERE";
export type DepreciationMethod = "LINEAR" | "DEGRESSIVE" | "NONE";
export type Prorata = "DAYS" | "MONTHS";

export const ASSET_CATEGORIES: AssetCategory[] = ["CORPORELLE", "INCORPORELLE", "FINANCIERE"];
export const DEPRECIATION_METHODS: DepreciationMethod[] = ["LINEAR", "DEGRESSIVE", "NONE"];

export interface FixedAsset {
  id: string;
  tenantId: string;
  label: string;
  reference: string | null;
  category: AssetCategory;
  accountNumber: string;
  depreciationAccountNumber: string | null;
  expenseAccountNumber: string;
  acquiredOn: string;
  inServiceOn: string;
  cost: string;
  residualValue: string;
  method: DepreciationMethod;
  durationMonths: number | null;
  prorata: Prorata;
  degressiveCoefficient: string | null;
  priorDepreciation: string;
  disposedOn: string | null;
  disposalPrice: string | null;
  acquisitionEntryId: string | null;
  disposalEntryId: string | null;
  disposalProceedsEntryId: string | null;
  createdAt: string;
}

export interface AcquisitionPosting {
  journalCode?: string;
  counterpartAccount: string;
  partnerId?: string;
  date?: string;
  reference?: string;
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
  acquisition?: AcquisitionPosting;
}

export interface DepreciationRow {
  id: string;
  assetId: string;
  fiscalYearId: string;
  periodEnd: string;
  dotation: string;
  cumulative: string;
  netBookValue: string;
  entryId: string | null;
}

export interface SchedulePeriod {
  index: number;
  periodStart: string;
  periodEnd: string;
  activeFrom: string;
  activeTo: string;
  base: string;
  dotation: string;
  cumulative: string;
  netBookValue: string;
  fraction?: string;
}

export interface AssetSchedule {
  asset: FixedAsset;
  plan: SchedulePeriod[];
  posted: DepreciationRow[];
}

export interface DepreciationRun {
  fiscalYearCode: string;
  date: string;
  entryId: string | null;
  rows: DepreciationRow[];
  skipped: Array<{ assetId: string; reason: string }>;
}

export interface DisposalResult {
  asset: FixedAsset;
  depreciationEntryId: string | null;
  disposalEntryId: string;
  proceedsEntryId: string | null;
  netBookValue: string;
  cumulativeDepreciation: string;
  gainLoss: string;
}

export interface AssetNoteRow {
  group: string;
  label: string;
  grossOpening: string;
  acquisitions: string;
  disposals: string;
  grossClosing: string;
  depreciationOpening: string;
  dotations: string;
  reversals: string;
  depreciationClosing: string;
  netClosing: string;
}

export interface AssetNotes {
  fiscalYearCode: string;
  from: string;
  to: string;
  rows: AssetNoteRow[];
  total: AssetNoteRow;
}
