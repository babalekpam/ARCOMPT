import type { Money } from "@arcompt/ledger";

export type SalesKind = "QUOTE" | "INVOICE" | "CREDIT_NOTE";
export type SalesStatus = "DRAFT" | "SENT" | "PARTIALLY_PAID" | "PAID" | "CANCELLED" | "ACCEPTED" | "REFUSED";
export type PurchaseKind = "SUPPLIER_INVOICE" | "SUPPLIER_CREDIT_NOTE" | "EXPENSE_CLAIM";
export type PurchaseStatus = "DRAFT" | "POSTED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
export type PaymentKind = "RECEIPT" | "DISBURSEMENT";
export type PaymentMethod = "BANK" | "CASH" | "MOBILE_MONEY" | "CHEQUE";
export type DunningChannel = "EMAIL" | "WHATSAPP" | "SMS";

/** Contexte tenant, toujours issu du jeton côté API. */
export interface TenantContext {
  tenantId: string;
  userId: string;
  organizationId?: string;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
export interface Product {
  id: string;
  code: string;
  label: string;
  description: string | null;
  defaultAccountNumber: string;
  vatCode: string | null;
  unitPrice: Money;
  unit: string;
  active: boolean;
}

export interface ProductInput {
  code: string;
  label: string;
  description?: string;
  defaultAccountNumber: string;
  vatCode?: string | null;
  unitPrice?: string;
  unit?: string;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Ventes
// ---------------------------------------------------------------------------
export interface SalesLineInput {
  productId?: string;
  label?: string;
  quantity?: string;
  unitPrice?: string;
  accountNumber?: string;
  /** null = hors champ de TVA ; absent = code du produit. */
  vatCode?: string | null;
}

export interface SalesDocumentInput {
  kind: SalesKind;
  partnerId: string;
  issueDate: string;
  dueDate?: string;
  currency?: string;
  notes?: string;
  lines: SalesLineInput[];
}

export interface SalesLine {
  id: string;
  lineNo: number;
  productId: string | null;
  label: string;
  quantity: string;
  unitPrice: Money;
  accountNumber: string;
  vatCode: string | null;
  vatRate: string;
  net: Money;
  vat: Money;
  gross: Money;
}

export interface Certification {
  system: string;
  reference: string;
  qrCode: string;
  certifiedAt: string;
}

export interface SalesDocument {
  id: string;
  kind: SalesKind;
  number: string | null;
  status: SalesStatus;
  partnerId: string;
  partnerName: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  totalNet: Money;
  totalVat: Money;
  totalGross: Money;
  paidAmount: Money;
  creditedAmount: Money;
  /** Reste à régler : TTC − réglé − avoirs (factures uniquement). */
  outstanding: Money;
  notes: string | null;
  entryId: string | null;
  certification: Certification | null;
  sourceDocumentId: string | null;
  lines: SalesLine[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Achats
// ---------------------------------------------------------------------------
export interface PurchaseLineInput {
  accountNumber: string;
  label: string;
  net: string;
  vatCode?: string | null;
}

export interface PurchaseDocumentInput {
  kind: PurchaseKind;
  partnerId: string;
  reference?: string;
  issueDate: string;
  dueDate?: string;
  currency?: string;
  notes?: string;
  documentId?: string;
  lines: PurchaseLineInput[];
}

export interface PurchaseLine {
  id: string;
  lineNo: number;
  accountNumber: string;
  label: string;
  vatCode: string | null;
  vatRate: string;
  net: Money;
  vat: Money;
  gross: Money;
}

export interface PurchaseDocument {
  id: string;
  kind: PurchaseKind;
  number: string | null;
  status: PurchaseStatus;
  partnerId: string;
  partnerName: string;
  reference: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  totalNet: Money;
  totalVat: Money;
  totalGross: Money;
  paidAmount: Money;
  creditedAmount: Money;
  outstanding: Money;
  notes: string | null;
  entryId: string | null;
  documentId: string | null;
  sourceDocumentId: string | null;
  lines: PurchaseLine[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Règlements
// ---------------------------------------------------------------------------
export interface AllocationInput {
  salesDocumentId?: string;
  purchaseDocumentId?: string;
  amount: string;
}

export interface PaymentInput {
  kind: PaymentKind;
  method: PaymentMethod;
  /** Compte de trésorerie ; défaut selon la méthode (BANK/CHEQUE → 521, CASH → 571, MOBILE_MONEY → 5381). */
  treasuryAccountNumber?: string;
  partnerId: string;
  amount: string;
  date: string;
  reference?: string;
  allocations?: AllocationInput[];
  provider?: string;
  providerTxId?: string;
}

export interface PaymentAllocation {
  id: string;
  salesDocumentId: string | null;
  purchaseDocumentId: string | null;
  amount: Money;
}

/**
 * RECORDED : écriture posée et affectations appliquées ;
 * PENDING_APPROVAL : montant ≥ seuil, attend l'approbation d'un autre utilisateur ;
 * REVIEW : écart entre montant attendu et reçu (webhook), revue humaine ;
 * REJECTED : refusé, jamais comptabilisé.
 */
export type PaymentStatus = "RECORDED" | "PENDING_APPROVAL" | "REVIEW" | "REJECTED";

export interface Payment {
  id: string;
  kind: PaymentKind;
  method: PaymentMethod;
  number: string;
  status: PaymentStatus;
  reviewReason: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  treasuryAccountNumber: string;
  partnerId: string;
  amount: Money;
  allocated: Money;
  currency: string;
  date: string;
  reference: string | null;
  entryId: string | null;
  provider: string | null;
  providerTxId: string | null;
  providerEventId: string | null;
  allocations: PaymentAllocation[];
  createdAt: string;
}

export interface WebhookOutcome {
  /** processed : règlement comptabilisé ; review : écart en revue ; duplicate : événement déjà traité ; ignored : statut non payé ou charge sans événement. */
  outcome: "processed" | "review" | "duplicate" | "ignored";
  eventId: string | null;
  payment: Payment | null;
}

export interface PaymentLink {
  id: string;
  salesDocumentId: string;
  provider: string;
  providerRef: string;
  url: string;
  amount: Money;
  currency: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
  paymentId: string | null;
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Balance âgée et relances
// ---------------------------------------------------------------------------
export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";
export const AGING_BUCKETS: AgingBucket[] = ["0-30", "31-60", "61-90", "90+"];

export interface AgedRow {
  partnerId: string;
  partnerName: string;
  buckets: Record<AgingBucket, Money>;
  total: Money;
  documents: number;
}

export interface AgedReport {
  asOf: string;
  currency: string;
  rows: AgedRow[];
  totals: Record<AgingBucket, Money>;
  total: Money;
}

export interface OverdueInvoice {
  documentId: string;
  number: string;
  partnerId: string;
  partnerName: string;
  partnerContact: Record<string, unknown>;
  issueDate: string;
  dueDate: string;
  daysOverdue: number;
  outstanding: Money;
  currency: string;
  lastDunningLevel: number;
  lastDunningAt: string | null;
  /** Prochain niveau de relance suggéré (1 → 3). */
  suggestedLevel: number;
}

export interface DunningInput {
  level: number;
  channel: DunningChannel;
  message?: string;
}

export interface Dunning {
  id: string;
  salesDocumentId: string;
  level: number;
  channel: DunningChannel;
  sentAt: string;
  message: string | null;
}
