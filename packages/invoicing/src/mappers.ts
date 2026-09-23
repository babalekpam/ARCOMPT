// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money } from "@arcompt/ledger";
import { dateText, isoText, money } from "./base.js";
import type { Payment, PaymentAllocation, PaymentLink, Product, PurchaseDocument, PurchaseLine, SalesDocument, SalesLine } from "./types.js";

type Row = Record<string, unknown>;

export function mapProduct(r: Row): Product {
  return {
    id: r.id as string,
    code: r.code as string,
    label: r.label as string,
    description: (r.description as string | null) ?? null,
    defaultAccountNumber: r.default_account_number as string,
    vatCode: (r.vat_code as string | null) ?? null,
    unitPrice: money(r.unit_price),
    unit: r.unit as string,
    active: Boolean(r.active),
  };
}

export function mapSalesLine(r: Row): SalesLine {
  return {
    id: r.id as string,
    lineNo: Number(r.line_no),
    productId: (r.product_id as string | null) ?? null,
    label: r.label as string,
    quantity: String(r.quantity),
    unitPrice: money(r.unit_price),
    accountNumber: r.account_number as string,
    vatCode: (r.vat_code as string | null) ?? null,
    vatRate: String(r.vat_rate),
    net: money(r.net),
    vat: money(r.vat),
    gross: money(r.gross),
  };
}

/** Reste à régler : TTC − réglé − avoirs, jamais négatif. */
export function outstandingOf(gross: Money, paid: Money, credited: Money): Money {
  const o = gross.sub(paid).sub(credited);
  return o.isNegative() ? Money.zero() : o;
}

export function mapSalesDocument(r: Row, lines: Row[]): SalesDocument {
  const totalGross = money(r.total_gross);
  const paid = money(r.paid_amount);
  const credited = money(r.credited_amount);
  return {
    id: r.id as string,
    kind: r.kind as SalesDocument["kind"],
    number: (r.number as string | null) ?? null,
    status: r.status as SalesDocument["status"],
    partnerId: r.partner_id as string,
    partnerName: (r.partner_name as string) ?? "",
    issueDate: dateText(r.issue_date),
    dueDate: r.due_date ? dateText(r.due_date) : null,
    currency: r.currency as string,
    totalNet: money(r.total_net),
    totalVat: money(r.total_vat),
    totalGross,
    paidAmount: paid,
    creditedAmount: credited,
    outstanding: r.kind === "INVOICE" ? outstandingOf(totalGross, paid, credited) : Money.zero(),
    notes: (r.notes as string | null) ?? null,
    entryId: (r.entry_id as string | null) ?? null,
    certification: (r.certification as SalesDocument["certification"]) ?? null,
    sourceDocumentId: (r.source_document_id as string | null) ?? null,
    lines: lines.map(mapSalesLine),
    createdAt: isoText(r.created_at),
    updatedAt: isoText(r.updated_at),
  };
}

export function mapPurchaseLine(r: Row): PurchaseLine {
  return {
    id: r.id as string,
    lineNo: Number(r.line_no),
    accountNumber: r.account_number as string,
    label: r.label as string,
    vatCode: (r.vat_code as string | null) ?? null,
    vatRate: String(r.vat_rate),
    net: money(r.net),
    vat: money(r.vat),
    gross: money(r.gross),
  };
}

export function mapPurchaseDocument(r: Row, lines: Row[]): PurchaseDocument {
  const totalGross = money(r.total_gross);
  const paid = money(r.paid_amount);
  const credited = money(r.credited_amount);
  return {
    id: r.id as string,
    kind: r.kind as PurchaseDocument["kind"],
    number: (r.number as string | null) ?? null,
    status: r.status as PurchaseDocument["status"],
    partnerId: r.partner_id as string,
    partnerName: (r.partner_name as string) ?? "",
    reference: (r.reference as string | null) ?? null,
    issueDate: dateText(r.issue_date),
    dueDate: r.due_date ? dateText(r.due_date) : null,
    currency: r.currency as string,
    totalNet: money(r.total_net),
    totalVat: money(r.total_vat),
    totalGross,
    paidAmount: paid,
    creditedAmount: credited,
    outstanding: r.kind === "SUPPLIER_CREDIT_NOTE" ? Money.zero() : outstandingOf(totalGross, paid, credited),
    notes: (r.notes as string | null) ?? null,
    entryId: (r.entry_id as string | null) ?? null,
    documentId: (r.document_id as string | null) ?? null,
    sourceDocumentId: (r.source_document_id as string | null) ?? null,
    lines: lines.map(mapPurchaseLine),
    createdAt: isoText(r.created_at),
    updatedAt: isoText(r.updated_at),
  };
}

export function mapAllocation(r: Row): PaymentAllocation {
  return {
    id: r.id as string,
    salesDocumentId: (r.sales_document_id as string | null) ?? null,
    purchaseDocumentId: (r.purchase_document_id as string | null) ?? null,
    amount: money(r.amount),
  };
}

export function mapPayment(r: Row, allocations: Row[]): Payment {
  const allocs = allocations.map(mapAllocation);
  return {
    id: r.id as string,
    kind: r.kind as Payment["kind"],
    method: r.method as Payment["method"],
    number: r.number as string,
    status: r.status as Payment["status"],
    reviewReason: (r.review_reason as string | null) ?? null,
    createdBy: r.created_by as string,
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: r.approved_at ? isoText(r.approved_at) : null,
    treasuryAccountNumber: r.treasury_account_number as string,
    partnerId: r.partner_id as string,
    amount: money(r.amount),
    allocated: allocs.reduce((a, x) => a.add(x.amount), Money.zero()),
    currency: r.currency as string,
    date: dateText(r.payment_date),
    reference: (r.reference as string | null) ?? null,
    entryId: (r.entry_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    providerTxId: (r.provider_tx_id as string | null) ?? null,
    providerEventId: (r.provider_event_id as string | null) ?? null,
    allocations: allocs,
    createdAt: isoText(r.created_at),
  };
}

export function mapPaymentLink(r: Row): PaymentLink {
  return {
    id: r.id as string,
    salesDocumentId: r.sales_document_id as string,
    provider: r.provider as string,
    providerRef: r.provider_ref as string,
    url: r.url as string,
    amount: money(r.amount),
    currency: r.currency as string,
    status: r.status as PaymentLink["status"],
    paymentId: (r.payment_id as string | null) ?? null,
    expiresAt: r.expires_at ? isoText(r.expires_at) : null,
  };
}
