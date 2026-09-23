// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { Money } from "@arcompt/ledger";
import { InvoicingError, money } from "./base.js";
import { mapPurchaseDocument, mapSalesDocument, outstandingOf } from "./mappers.js";
import type { PurchaseDocument, PurchaseStatus, SalesDocument, SalesStatus } from "./types.js";

/**
 * Accès partagé aux documents (ventes et achats) : chargement avec ou sans
 * verrou, et recalcul du statut de règlement à partir des montants.
 */

export async function loadSalesDocument(tx: Sql, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<SalesDocument> {
  const rows = opts.forUpdate
    ? await tx`SELECT d.*, (SELECT name FROM partner p WHERE p.id = d.partner_id) AS partner_name FROM sales_document d WHERE d.tenant_id = ${tenantId} AND d.id = ${id} FOR UPDATE OF d`
    : await tx`SELECT d.*, p.name AS partner_name FROM sales_document d JOIN partner p ON p.id = d.partner_id WHERE d.tenant_id = ${tenantId} AND d.id = ${id}`;
  const r = rows[0];
  if (!r) throw new InvoicingError("NOT_FOUND", `Document de vente ${id} introuvable`);
  const lines = await tx`SELECT * FROM sales_document_line WHERE tenant_id = ${tenantId} AND document_id = ${id} ORDER BY line_no`;
  return mapSalesDocument(r, lines);
}

export async function loadPurchaseDocument(tx: Sql, tenantId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<PurchaseDocument> {
  const rows = opts.forUpdate
    ? await tx`SELECT d.*, (SELECT name FROM partner p WHERE p.id = d.partner_id) AS partner_name FROM purchase_document d WHERE d.tenant_id = ${tenantId} AND d.id = ${id} FOR UPDATE OF d`
    : await tx`SELECT d.*, p.name AS partner_name FROM purchase_document d JOIN partner p ON p.id = d.partner_id WHERE d.tenant_id = ${tenantId} AND d.id = ${id}`;
  const r = rows[0];
  if (!r) throw new InvoicingError("NOT_FOUND", `Document d'achat ${id} introuvable`);
  const lines = await tx`SELECT * FROM purchase_document_line WHERE tenant_id = ${tenantId} AND document_id = ${id} ORDER BY line_no`;
  return mapPurchaseDocument(r, lines);
}

/** Statut de règlement d'une facture émise : SENT → PARTIALLY_PAID → PAID. */
export function settlementStatus(gross: Money, paid: Money, credited: Money, issued: "SENT" | "POSTED"): "SENT" | "POSTED" | "PARTIALLY_PAID" | "PAID" {
  if (gross.isZero() && paid.isZero()) return issued;
  if (outstandingOf(gross, paid, credited).isZero()) return "PAID";
  if (paid.isPositive() || credited.isPositive()) return "PARTIALLY_PAID";
  return issued;
}

const SALES_SETTLED: SalesStatus[] = ["SENT", "PARTIALLY_PAID", "PAID"];
const PURCHASE_SETTLED: PurchaseStatus[] = ["POSTED", "PARTIALLY_PAID", "PAID"];

/** Ajoute un règlement ou un avoir à une facture de vente et recalcule son statut. */
export async function applyToSalesInvoice(tx: Sql, tenantId: string, id: string, delta: { paid?: Money; credited?: Money }): Promise<SalesDocument> {
  const [r] = await tx`SELECT kind, status, total_gross, paid_amount, credited_amount FROM sales_document WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  if (!r) throw new InvoicingError("NOT_FOUND", `Facture ${id} introuvable`);
  if (r.kind !== "INVOICE" || !SALES_SETTLED.includes(r.status as SalesStatus)) {
    throw new InvoicingError("INVALID_STATUS", `Le document ${id} n'est pas une facture émise (${r.kind} ${r.status})`);
  }
  const paid = money(r.paid_amount).add(delta.paid ?? Money.zero());
  const credited = money(r.credited_amount).add(delta.credited ?? Money.zero());
  const status = settlementStatus(money(r.total_gross), paid, credited, "SENT");
  await tx`UPDATE sales_document SET paid_amount = ${paid.toString()}, credited_amount = ${credited.toString()}, status = ${status} WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return loadSalesDocument(tx, tenantId, id);
}

/** Idem pour une facture fournisseur ou une note de frais comptabilisée. */
export async function applyToPurchaseInvoice(tx: Sql, tenantId: string, id: string, delta: { paid?: Money; credited?: Money }): Promise<PurchaseDocument> {
  const [r] = await tx`SELECT kind, status, total_gross, paid_amount, credited_amount FROM purchase_document WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  if (!r) throw new InvoicingError("NOT_FOUND", `Document d'achat ${id} introuvable`);
  if (r.kind === "SUPPLIER_CREDIT_NOTE" || !PURCHASE_SETTLED.includes(r.status as PurchaseStatus)) {
    throw new InvoicingError("INVALID_STATUS", `Le document ${id} n'est pas une facture d'achat comptabilisée (${r.kind} ${r.status})`);
  }
  const paid = money(r.paid_amount).add(delta.paid ?? Money.zero());
  const credited = money(r.credited_amount).add(delta.credited ?? Money.zero());
  const status = settlementStatus(money(r.total_gross), paid, credited, "POSTED");
  await tx`UPDATE purchase_document SET paid_amount = ${paid.toString()}, credited_amount = ${credited.toString()}, status = ${status} WHERE tenant_id = ${tenantId} AND id = ${id}`;
  return loadPurchaseDocument(tx, tenantId, id);
}
