/**
 * Types des réponses de l'API facturation (/v1/products, /sales, /purchases,
 * /payments, /receivables, /payables, /dunning, /partners). Copiés des paquets
 * serveur : les montants sont des chaînes canoniques à 4 décimales.
 */
export type SalesKind = "QUOTE" | "INVOICE" | "CREDIT_NOTE";
export type SalesStatus = "DRAFT" | "SENT" | "PARTIALLY_PAID" | "PAID" | "CANCELLED" | "ACCEPTED" | "REFUSED";
export type PurchaseKind = "SUPPLIER_INVOICE" | "SUPPLIER_CREDIT_NOTE" | "EXPENSE_CLAIM";
export type PurchaseStatus = "DRAFT" | "POSTED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
export type PaymentKind = "RECEIPT" | "DISBURSEMENT";
export type PaymentMethod = "BANK" | "CASH" | "MOBILE_MONEY" | "CHEQUE";
export type PaymentStatus = "RECORDED" | "PENDING_APPROVAL" | "REVIEW" | "REJECTED";
export type DunningChannel = "EMAIL" | "WHATSAPP" | "SMS";
export type PartnerType = "CUSTOMER" | "SUPPLIER" | "EMPLOYEE" | "STATE" | "OTHER";

export const SALES_KINDS: SalesKind[] = ["QUOTE", "INVOICE", "CREDIT_NOTE"];
export const SALES_STATUSES: SalesStatus[] = ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED", "ACCEPTED", "REFUSED"];
export const PURCHASE_KINDS: PurchaseKind[] = ["SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE", "EXPENSE_CLAIM"];
export const PURCHASE_STATUSES: PurchaseStatus[] = ["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"];
export const PAYMENT_KINDS: PaymentKind[] = ["RECEIPT", "DISBURSEMENT"];
export const PAYMENT_METHODS: PaymentMethod[] = ["BANK", "CASH", "MOBILE_MONEY", "CHEQUE"];
export const PAYMENT_STATUSES: PaymentStatus[] = ["RECORDED", "PENDING_APPROVAL", "REVIEW", "REJECTED"];
export const DUNNING_CHANNELS: DunningChannel[] = ["EMAIL", "WHATSAPP", "SMS"];

export interface Partner {
  id: string;
  type: PartnerType;
  name: string;
  taxId: string | null;
  collectiveAccount: string;
  contact: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}

export interface Product {
  id: string;
  code: string;
  label: string;
  description: string | null;
  defaultAccountNumber: string;
  vatCode: string | null;
  unitPrice: string;
  unit: string;
  active: boolean;
}

export interface SalesLine {
  id: string;
  lineNo: number;
  productId: string | null;
  label: string;
  quantity: string;
  unitPrice: string;
  accountNumber: string;
  vatCode: string | null;
  vatRate: string;
  net: string;
  vat: string;
  gross: string;
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
  totalNet: string;
  totalVat: string;
  totalGross: string;
  paidAmount: string;
  creditedAmount: string;
  outstanding: string;
  notes: string | null;
  entryId: string | null;
  certification: Certification | null;
  sourceDocumentId: string | null;
  lines: SalesLine[];
  createdAt: string;
  updatedAt: string;
}

export interface SalesLineInput {
  productId?: string;
  label?: string;
  quantity?: string;
  unitPrice?: string;
  accountNumber?: string;
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

export interface PurchaseLine {
  id: string;
  lineNo: number;
  accountNumber: string;
  label: string;
  vatCode: string | null;
  vatRate: string;
  net: string;
  vat: string;
  gross: string;
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
  totalNet: string;
  totalVat: string;
  totalGross: string;
  paidAmount: string;
  creditedAmount: string;
  outstanding: string;
  notes: string | null;
  entryId: string | null;
  documentId: string | null;
  sourceDocumentId: string | null;
  lines: PurchaseLine[];
  createdAt: string;
  updatedAt: string;
}

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

export interface AllocationInput {
  salesDocumentId?: string;
  purchaseDocumentId?: string;
  amount: string;
}

export interface PaymentInput {
  kind: PaymentKind;
  method: PaymentMethod;
  treasuryAccountNumber?: string;
  partnerId: string;
  amount: string;
  date: string;
  reference?: string;
  allocations?: AllocationInput[];
}

export interface PaymentAllocation {
  id: string;
  salesDocumentId: string | null;
  purchaseDocumentId: string | null;
  amount: string;
}

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
  amount: string;
  allocated: string;
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

export interface PaymentLink {
  id: string;
  salesDocumentId: string;
  provider: string;
  providerRef: string;
  url: string;
  amount: string;
  currency: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
  paymentId: string | null;
  expiresAt: string | null;
}

export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";
export const AGING_BUCKETS: AgingBucket[] = ["0-30", "31-60", "61-90", "90+"];

export interface AgedRow {
  partnerId: string;
  partnerName: string;
  buckets: Record<AgingBucket, string>;
  total: string;
  documents: number;
}

export interface AgedReport {
  asOf: string;
  currency: string;
  rows: AgedRow[];
  totals: Record<AgingBucket, string>;
  total: string;
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
  outstanding: string;
  currency: string;
  lastDunningLevel: number;
  lastDunningAt: string | null;
  suggestedLevel: number;
}

export interface Dunning {
  id: string;
  salesDocumentId: string;
  level: number;
  channel: DunningChannel;
  sentAt: string;
  message: string | null;
}

/** Taux de TVA d'un pack pays (GET /v1/packs/:code → vat.rates). */
export interface PackVatRate {
  code: string;
  label: string;
  rate: string | number;
  valid_from?: string;
  valid_to?: string;
}

export interface PdfData {
  document: SalesDocument;
  company: { name: string; countryCode: string; currency: string; taxIds: Record<string, string> };
  partner: { id: string; name: string; type: string; collectiveAccount: string; contact: Record<string, unknown>; taxId: string | null };
  vatSummary: Array<{ vatCode: string; rate: string; base: string; vat: string }>;
  source: { number: string; kind: SalesKind } | null;
  certification: Certification | null;
  pack: { code: string; certifiedInvoiceSystem: string | null };
}
