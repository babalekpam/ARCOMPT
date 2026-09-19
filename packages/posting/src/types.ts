import type { EntrySource, Money } from "@arcompt/ledger";
import type { CountryPack } from "@arcompt/country-packs";

/** Événements métier reconnus par le moteur d'imputation. */
export type PostingEventKind =
  | "SALES_INVOICE"
  | "SALES_CREDIT_NOTE"
  | "CUSTOMER_PAYMENT"
  | "PURCHASE_INVOICE"
  | "PURCHASE_CREDIT_NOTE"
  | "SUPPLIER_PAYMENT"
  | "EXPENSE_CLAIM"
  | "PAYROLL_RUN"
  | "VAT_SETTLEMENT"
  | "DEPRECIATION";

/**
 * Rôle comptable d'une ligne de modèle. Le rôle est résolu en numéro de
 * compte par `resolveAccount` : tiers collectif, compte de la ligne
 * (produit / charge / amortissement), compte de TVA du pack, trésorerie…
 */
export type AccountRole =
  | "customer" // 411 (ou compte collectif du tiers)
  | "supplier" // 401
  | "employee" // 421 (avances, notes de frais)
  | "revenue" // 70x : compte de la ligne ou défaut 706
  | "expense" // 6xx : compte de la ligne ou défaut
  | "vat_collected" // pack : collected_account du code TVA
  | "vat_deductible" // pack : deductible_account du code TVA
  | "vat_due" // 444
  | "treasury" // 521 / 571 / 5381 selon l'événement
  | "salary_expense" // 661
  | "social_expense" // 664
  | "salary_payable" // 422
  | "social_body" // 431
  | "withholding_tax" // 447 (ITS retenu)
  | "depreciation_expense" // 681
  | "depreciation"; // 28xx : compte de la ligne

export type Side = "debit" | "credit";

/**
 * Sélecteur de montant d'une règle de ligne :
 *  - line_net / line_vat / line_gross : par ligne de document (HT, TVA, TTC) ;
 *  - total_net / total_vat / total_gross : totaux du document ;
 *  - field : montant nommé de l'événement (`event.amounts[name]`) ;
 *  - balance : le montant qui équilibre l'écriture (calculé en dernier).
 */
export type AmountSelector =
  | "line_net"
  | "line_vat"
  | "line_gross"
  | "total_net"
  | "total_vat"
  | "total_gross"
  | "balance"
  | { field: string };

/**
 * Regroupement des lignes d'écriture produites par une règle :
 *  - none : une seule ligne (somme) ;
 *  - line : une ligne d'écriture par ligne de document ;
 *  - account : une ligne par compte résolu ;
 *  - vat_code : une ligne par code TVA (compte résolu par code).
 */
export type LineGrouping = "none" | "line" | "account" | "vat_code";

export interface LineRule {
  role: AccountRole;
  side: Side;
  amount: AmountSelector;
  group?: LineGrouping;
  /** D'où vient le tiers de la ligne : de l'événement, de la ligne, ou aucun. */
  partner?: "event" | "line" | "none";
  /** Libellé : `{label}` = libellé de l'événement, `{line}` = libellé de la ligne. */
  label?: string;
  /** Reporte le code TVA sur la ligne d'écriture (lignes de TVA). */
  withVatCode?: boolean;
}

export interface PostingTemplate {
  kind: PostingEventKind;
  /** Code du journal, ou fonction de l'événement (banque / caisse selon le compte de trésorerie). */
  journalCode: string | ((event: PostingEvent) => string);
  source: EntrySource;
  lines: LineRule[];
  /** Arrondi de la TVA : par ligne (défaut) ou sur le total par code. */
  vatRounding?: VatRounding;
}

export type VatRounding = "per_line" | "total";

/** Ligne d'un document métier (facture, note de frais, plan d'amortissement…). */
export interface EventLine {
  label?: string;
  /** Montant HT (ou montant unique pour les événements sans TVA), chaîne décimale ou Money. */
  amount: Money | string;
  /** Compte de produit / charge / amortissement propre à la ligne. */
  accountNumber?: string;
  vatCode?: string;
  /** Tiers propre à la ligne (net à payer par salarié…). */
  partnerId?: string;
  analyticCode?: string;
}

export interface PostingEvent {
  kind: PostingEventKind;
  /** Date d'écriture (ISO). */
  date: string;
  /** Numéro de pièce (numéro légal de la facture, référence du règlement). */
  reference?: string;
  label: string;
  currency: string;
  /** Tiers principal (client, fournisseur, salarié). */
  partnerId?: string;
  /** Compte collectif du tiers (411, 4111, 401…) si différent du défaut. */
  partnerAccountNumber?: string;
  /** Compte de trésorerie (521, 571, 5381) pour les règlements. */
  treasuryAccountNumber?: string;
  lines?: EventLine[];
  /** Montants nommés (règlements, paie, liquidation de TVA). */
  amounts?: Record<string, Money | string>;
  /** Identifiant client pour l'idempotence (synchronisation hors ligne). */
  clientId?: string;
}

export interface PostingContext {
  pack: CountryPack;
  /** Devise du dossier : fixe l'arrondi des montants. */
  currency: string;
  /** Comptes par rôle propres au dossier (ex. withholding_tax → 4471 via chart_overrides). */
  accounts?: Partial<Record<AccountRole, string>>;
  /** Surcharge l'arrondi de TVA du modèle. */
  vatRounding?: VatRounding;
}

/** Résultat du calcul de TVA d'un document. */
export interface ComputedLine {
  index: number;
  label: string;
  net: Money;
  vatCode: string | null;
  vatRate: string;
  vat: Money;
  gross: Money;
  accountNumber: string | null;
  partnerId: string | null;
  analyticCode: string | null;
}

export interface VatSummaryRow {
  vatCode: string;
  rate: string;
  base: Money;
  vat: Money;
  collectedAccount: string;
  deductibleAccount: string;
}

export interface DocumentTotals {
  lines: ComputedLine[];
  byVatCode: VatSummaryRow[];
  totalNet: Money;
  totalVat: Money;
  totalGross: Money;
  currency: string;
  decimals: number;
}
