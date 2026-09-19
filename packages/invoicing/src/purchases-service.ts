import type { Sql } from "postgres";
import { Money } from "@arcompt/ledger";
import { buildEntry, computeDocumentTotals, currencyDecimals, type EventLine, type PostingEvent } from "@arcompt/posting";
import { BaseService, EVENT_KIND_BY_PURCHASE, InvoicingError, assertDate, money } from "./base.js";
import { applyToPurchaseInvoice, loadPurchaseDocument } from "./documents.js";
import { buildAgedReport } from "./invoicing-service.js";
import { mapPurchaseDocument } from "./mappers.js";
import type { AgedReport, PurchaseDocument, PurchaseDocumentInput, PurchaseKind, PurchaseLineInput, PurchaseStatus } from "./types.js";

export interface PurchaseListFilter {
  kind?: PurchaseKind;
  status?: PurchaseStatus;
  partnerId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

const PARTNER_TYPES: Record<PurchaseKind, string[]> = {
  SUPPLIER_INVOICE: ["SUPPLIER", "OTHER"],
  SUPPLIER_CREDIT_NOTE: ["SUPPLIER", "OTHER"],
  EXPENSE_CLAIM: ["EMPLOYEE"],
};

/** Achats et dépenses : factures fournisseurs, avoirs fournisseurs, notes de frais. */
export class PurchasesService extends BaseService {
  async list(filter: PurchaseListFilter = {}): Promise<PurchaseDocument[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT d.*, p.name AS partner_name
          FROM purchase_document d JOIN partner p ON p.id = d.partner_id
         WHERE d.tenant_id = ${this.tenantId}
           ${filter.kind ? tx`AND d.kind = ${filter.kind}` : tx``}
           ${filter.status ? tx`AND d.status = ${filter.status}` : tx``}
           ${filter.partnerId ? tx`AND d.partner_id = ${filter.partnerId}` : tx``}
           ${filter.from ? tx`AND d.issue_date >= ${filter.from}` : tx``}
           ${filter.to ? tx`AND d.issue_date <= ${filter.to}` : tx``}
         ORDER BY d.issue_date DESC, d.created_at DESC
         LIMIT ${filter.limit ?? 200}`;
      const out: PurchaseDocument[] = [];
      for (const r of rows) {
        const lines = await tx`SELECT * FROM purchase_document_line WHERE tenant_id = ${this.tenantId} AND document_id = ${r.id as string} ORDER BY line_no`;
        out.push(mapPurchaseDocument(r, lines));
      }
      return out;
    });
  }

  async get(id: string): Promise<PurchaseDocument> {
    return this.tx((tx) => loadPurchaseDocument(tx, this.tenantId, id));
  }

  async createDraft(input: PurchaseDocumentInput, opts: { sourceDocumentId?: string } = {}): Promise<PurchaseDocument> {
    this.validateInput(input);
    const currency = input.currency ?? this.deps.currency;
    return this.tx(async (tx) => {
      const partner = await this.loadPartner(tx, input.partnerId);
      if (!PARTNER_TYPES[input.kind].includes(partner.type)) {
        throw new InvoicingError("PARTNER_MISMATCH", `Un document ${input.kind} exige un tiers ${PARTNER_TYPES[input.kind].join(" ou ")} (reçu ${partner.type})`);
      }
      const totals = this.totalsOf(input.lines, input.issueDate, currency);
      const [d] = await tx`
        INSERT INTO purchase_document (tenant_id, kind, status, partner_id, reference, issue_date, due_date, currency, total_net, total_vat, total_gross, notes, document_id, source_document_id, created_by)
        VALUES (${this.tenantId}, ${input.kind}, 'DRAFT', ${input.partnerId}, ${input.reference ?? null}, ${input.issueDate}, ${input.dueDate ?? null}, ${currency},
                ${totals.totalNet.toString()}, ${totals.totalVat.toString()}, ${totals.totalGross.toString()}, ${input.notes ?? null}, ${input.documentId ?? null},
                ${opts.sourceDocumentId ?? null}, ${this.ctx.userId})
        RETURNING id`;
      const id = d!.id as string;
      await this.insertLines(tx, id, input.lines, totals);
      await this.audit(tx, "purchase.draft", "purchase_document", id, { kind: input.kind, totalGross: totals.totalGross.toString() });
      return loadPurchaseDocument(tx, this.tenantId, id);
    });
  }

  async updateDraft(id: string, input: Partial<PurchaseDocumentInput>): Promise<PurchaseDocument> {
    return this.tx(async (tx) => {
      const cur = await loadPurchaseDocument(tx, this.tenantId, id, { forUpdate: true });
      if (cur.status !== "DRAFT") throw new InvoicingError("INVALID_STATUS", `Le document ${cur.number ?? id} est comptabilisé ; corrigez-le par un avoir`);
      const merged: PurchaseDocumentInput = {
        kind: cur.kind,
        partnerId: input.partnerId ?? cur.partnerId,
        ...(input.reference !== undefined ? { reference: input.reference } : cur.reference ? { reference: cur.reference } : {}),
        issueDate: input.issueDate ?? cur.issueDate,
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : cur.dueDate ? { dueDate: cur.dueDate } : {}),
        currency: input.currency ?? cur.currency,
        ...(input.notes !== undefined ? { notes: input.notes } : cur.notes ? { notes: cur.notes } : {}),
        ...(input.documentId !== undefined ? { documentId: input.documentId } : cur.documentId ? { documentId: cur.documentId } : {}),
        lines: input.lines ?? cur.lines.map((l) => ({ accountNumber: l.accountNumber, label: l.label, net: l.net.toString(), vatCode: l.vatCode })),
      };
      this.validateInput(merged);
      const totals = this.totalsOf(merged.lines, merged.issueDate, merged.currency!);
      await tx`
        UPDATE purchase_document SET partner_id = ${merged.partnerId}, reference = ${merged.reference ?? null}, issue_date = ${merged.issueDate}, due_date = ${merged.dueDate ?? null},
               currency = ${merged.currency!}, total_net = ${totals.totalNet.toString()}, total_vat = ${totals.totalVat.toString()}, total_gross = ${totals.totalGross.toString()},
               notes = ${merged.notes ?? null}, document_id = ${merged.documentId ?? null}
         WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await tx`DELETE FROM purchase_document_line WHERE tenant_id = ${this.tenantId} AND document_id = ${id}`;
      await this.insertLines(tx, id, merged.lines, totals);
      return loadPurchaseDocument(tx, this.tenantId, id);
    });
  }

  /** Comptabilisation : numéro interne, écriture (6xx / 445 à 401 ou 421), statut POSTED. */
  async issue(id: string): Promise<PurchaseDocument> {
    return this.tx(async (tx) => {
      const doc = await loadPurchaseDocument(tx, this.tenantId, id, { forUpdate: true });
      if (doc.status !== "DRAFT") throw new InvoicingError("INVALID_STATUS", `Le document ${doc.number ?? id} est déjà comptabilisé (${doc.status})`);
      if (doc.lines.length === 0) throw new InvoicingError("VALIDATION", "Un document sans ligne ne se comptabilise pas");
      await this.assertOpenPeriod(tx, doc.issueDate);
      const number = await this.nextNumber(tx, doc.kind, doc.issueDate);
      const partner = await this.loadPartner(tx, doc.partnerId);
      const kind = EVENT_KIND_BY_PURCHASE[doc.kind];
      const event: PostingEvent = {
        kind,
        date: doc.issueDate,
        reference: doc.reference ?? number,
        label: `${labelOf(doc.kind)} ${number} ${partner.name}${doc.reference ? ` (${doc.reference})` : ""}`,
        currency: doc.currency,
        partnerId: doc.partnerId,
        partnerAccountNumber: partner.collectiveAccount,
        lines: doc.lines.map<EventLine>((l) => ({ label: l.label, amount: l.net, accountNumber: l.accountNumber, ...(l.vatCode ? { vatCode: l.vatCode } : {}) })),
      };
      const entry = await this.deps.ledger.post(this.actor, buildEntry(event, this.template(kind), this.postingContext()));
      await tx`UPDATE purchase_document SET number = ${number}, status = 'POSTED', entry_id = ${entry.id} WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      if (doc.kind === "SUPPLIER_CREDIT_NOTE" && doc.sourceDocumentId) {
        await applyToPurchaseInvoice(tx, this.tenantId, doc.sourceDocumentId, { credited: doc.totalGross });
      }
      await this.audit(tx, "purchase.issue", "purchase_document", id, { kind: doc.kind, number, entryId: entry.id });
      return loadPurchaseDocument(tx, this.tenantId, id);
    });
  }

  async cancel(id: string): Promise<PurchaseDocument> {
    return this.tx(async (tx) => {
      const doc = await loadPurchaseDocument(tx, this.tenantId, id, { forUpdate: true });
      if (doc.status !== "DRAFT") throw new InvoicingError("INVALID_STATUS", `Le document ${doc.number} est comptabilisé : établissez un avoir`);
      await tx`UPDATE purchase_document SET status = 'CANCELLED' WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await this.audit(tx, "purchase.cancel", "purchase_document", id, { status: "CANCELLED" }, { status: "DRAFT" });
      return loadPurchaseDocument(tx, this.tenantId, id);
    });
  }

  /** Avoir fournisseur (brouillon) sur une facture comptabilisée. */
  async createCreditNote(invoiceId: string, opts: { issueDate: string; reference?: string; lines?: PurchaseLineInput[]; notes?: string }): Promise<PurchaseDocument> {
    assertDate(opts.issueDate, "issueDate");
    const invoice = await this.get(invoiceId);
    if (invoice.kind !== "SUPPLIER_INVOICE" || !["POSTED", "PARTIALLY_PAID", "PAID"].includes(invoice.status)) {
      throw new InvoicingError("INVALID_STATUS", `Un avoir fournisseur ne se fait que sur une facture comptabilisée (${invoice.kind} ${invoice.status})`);
    }
    return this.createDraft(
      {
        kind: "SUPPLIER_CREDIT_NOTE",
        partnerId: invoice.partnerId,
        ...(opts.reference ? { reference: opts.reference } : {}),
        issueDate: opts.issueDate,
        currency: invoice.currency,
        notes: opts.notes ?? `Avoir sur facture ${invoice.number}`,
        lines: opts.lines ?? invoice.lines.map((l) => ({ accountNumber: l.accountNumber, label: l.label, net: l.net.toString(), vatCode: l.vatCode })),
      },
      { sourceDocumentId: invoiceId },
    );
  }

  /** Dettes fournisseurs (et notes de frais) par tranche d'ancienneté. */
  async getAgedPayables(asOf: string): Promise<AgedReport> {
    assertDate(asOf, "asOf");
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT d.partner_id, p.name AS partner_name, d.issue_date::text AS issue_date, d.due_date::text AS due_date,
               d.total_gross, d.paid_amount, d.credited_amount
          FROM purchase_document d JOIN partner p ON p.id = d.partner_id
         WHERE d.tenant_id = ${this.tenantId} AND d.kind IN ('SUPPLIER_INVOICE', 'EXPENSE_CLAIM') AND d.status IN ('POSTED', 'PARTIALLY_PAID') AND d.issue_date <= ${asOf}`;
      return buildAgedReport(asOf, this.deps.currency, rows);
    });
  }

  // -------------------------------------------------------------------------
  private validateInput(input: PurchaseDocumentInput): void {
    assertDate(input.issueDate, "issueDate");
    if (input.dueDate) {
      assertDate(input.dueDate, "dueDate");
      if (input.dueDate < input.issueDate) throw new InvoicingError("VALIDATION", "L'échéance précède la date de facture");
    }
    if (!Array.isArray(input.lines)) throw new InvoicingError("VALIDATION", "lines requis");
    for (const l of input.lines) {
      if (!l.label || !l.accountNumber) throw new InvoicingError("VALIDATION", "Chaque ligne exige un libellé et un compte de charge");
      if (!/^6\d{1,12}$/.test(l.accountNumber) && !/^2\d{1,12}$/.test(l.accountNumber)) throw new InvoicingError("VALIDATION", `Compte ${l.accountNumber} : un achat s'impute en classe 6 (charge) ou 2 (immobilisation)`);
      if (l.vatCode && !this.deps.pack.vat.rates.some((r) => r.code === l.vatCode && r.valid_from <= input.issueDate && (r.valid_to === undefined || input.issueDate <= r.valid_to))) {
        throw new InvoicingError("VALIDATION", `Code TVA ${l.vatCode} inconnu du pack ${this.deps.pack.code} au ${input.issueDate}`);
      }
      if (money(l.net).isNegative()) throw new InvoicingError("VALIDATION", "Montant HT négatif : utilisez un avoir");
    }
  }

  private totalsOf(lines: PurchaseLineInput[], date: string, currency: string) {
    const decimals = currencyDecimals(currency);
    return computeDocumentTotals(
      lines.map((l) => ({ label: l.label, amount: Money.parse(l.net).roundTo(decimals), accountNumber: l.accountNumber, ...(l.vatCode ? { vatCode: l.vatCode } : {}) })),
      { pack: this.deps.pack, date, currency },
    );
  }

  private async insertLines(tx: Sql, documentId: string, lines: PurchaseLineInput[], totals: ReturnType<typeof computeDocumentTotals>): Promise<void> {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const c = totals.lines[i]!;
      await tx`
        INSERT INTO purchase_document_line (tenant_id, document_id, line_no, account_number, label, net, vat_code, vat_rate, vat, gross)
        VALUES (${this.tenantId}, ${documentId}, ${i + 1}, ${l.accountNumber}, ${l.label}, ${c.net.toString()}, ${l.vatCode ?? null}, ${c.vatRate}, ${c.vat.toString()}, ${c.gross.toString()})`;
    }
  }
}

function labelOf(kind: PurchaseKind): string {
  return kind === "SUPPLIER_INVOICE" ? "Facture fournisseur" : kind === "SUPPLIER_CREDIT_NOTE" ? "Avoir fournisseur" : "Note de frais";
}
