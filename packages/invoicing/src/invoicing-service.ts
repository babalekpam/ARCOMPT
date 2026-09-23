import type { Sql } from "postgres";
import { decryptTaxId, decryptTaxIds, existingTenantCipherIn } from "@arcompt/db";
import { Money } from "@arcompt/ledger";
import { buildEntry, computeDocumentTotals, currencyDecimals, type EventLine, type PostingEvent } from "@arcompt/posting";
import { BaseService, InvoicingError, assertDate, dateText, daysBetween, isoText, money } from "./base.js";
import { certificationRequired, toCertification } from "./certification.js";
import { applyToSalesInvoice, loadSalesDocument } from "./documents.js";
import type { DunningDispatch } from "./dunning.js";
import { mapProduct, mapSalesDocument, outstandingOf } from "./mappers.js";
import {
  AGING_BUCKETS,
  type AgedReport,
  type AgedRow,
  type AgingBucket,
  type Dunning,
  type DunningInput,
  type OverdueInvoice,
  type Product,
  type ProductInput,
  type SalesDocument,
  type SalesDocumentInput,
  type SalesKind,
  type SalesLineInput,
  type SalesStatus,
} from "./types.js";

/** Ligne de vente résolue (produit appliqué) avant calcul de TVA. */
interface ResolvedLine {
  productId: string | null;
  label: string;
  quantity: string;
  unitPrice: Money;
  accountNumber: string;
  vatCode: string | null;
  net: Money;
}

export interface SalesListFilter {
  kind?: SalesKind;
  status?: SalesStatus;
  partnerId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * Facturation : catalogue, devis, factures, avoirs, balance âgée, relances.
 * Toute écriture passe par le moteur d'imputation puis `Ledger.post()`.
 */
export class InvoicingService extends BaseService {
  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------
  async listProducts(opts: { includeInactive?: boolean } = {}): Promise<Product[]> {
    return this.tx(async (tx) =>
      (await tx`SELECT * FROM product WHERE tenant_id = ${this.tenantId} ${opts.includeInactive ? tx`` : tx`AND active`} ORDER BY code`).map(mapProduct),
    );
  }

  async getProduct(id: string): Promise<Product> {
    return this.tx(async (tx) => {
      const [r] = await tx`SELECT * FROM product WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      if (!r) throw new InvoicingError("NOT_FOUND", `Produit ${id} introuvable`);
      return mapProduct(r);
    });
  }

  async createProduct(input: ProductInput): Promise<Product> {
    if (input.vatCode) this.assertVatCode(input.vatCode, this.today());
    const unitPrice = Money.parse(input.unitPrice ?? "0");
    return this.tx(async (tx) => {
      const [dup] = await tx`SELECT 1 FROM product WHERE tenant_id = ${this.tenantId} AND code = ${input.code}`;
      if (dup) throw new InvoicingError("DUPLICATE", `Produit ${input.code} déjà présent`);
      const [r] = await tx`
        INSERT INTO product (tenant_id, code, label, description, default_account_number, vat_code, unit_price, unit, active)
        VALUES (${this.tenantId}, ${input.code}, ${input.label}, ${input.description ?? null}, ${input.defaultAccountNumber}, ${input.vatCode ?? null},
                ${unitPrice.toString()}, ${input.unit ?? "u"}, ${input.active ?? true})
        RETURNING *`;
      return mapProduct(r!);
    });
  }

  async updateProduct(id: string, input: Partial<ProductInput>): Promise<Product> {
    if (input.vatCode) this.assertVatCode(input.vatCode, this.today());
    return this.tx(async (tx) => {
      const [cur] = await tx`SELECT * FROM product WHERE tenant_id = ${this.tenantId} AND id = ${id} FOR UPDATE`;
      if (!cur) throw new InvoicingError("NOT_FOUND", `Produit ${id} introuvable`);
      const [r] = await tx`
        UPDATE product SET
          code = ${input.code ?? (cur.code as string)},
          label = ${input.label ?? (cur.label as string)},
          description = ${input.description === undefined ? ((cur.description as string | null) ?? null) : input.description},
          default_account_number = ${input.defaultAccountNumber ?? (cur.default_account_number as string)},
          vat_code = ${input.vatCode === undefined ? ((cur.vat_code as string | null) ?? null) : input.vatCode},
          unit_price = ${input.unitPrice === undefined ? String(cur.unit_price) : Money.parse(input.unitPrice).toString()},
          unit = ${input.unit ?? (cur.unit as string)},
          active = ${input.active ?? Boolean(cur.active)}
        WHERE tenant_id = ${this.tenantId} AND id = ${id}
        RETURNING *`;
      return mapProduct(r!);
    });
  }

  // -------------------------------------------------------------------------
  // Documents de vente
  // -------------------------------------------------------------------------
  async list(filter: SalesListFilter = {}): Promise<SalesDocument[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT d.*, p.name AS partner_name
          FROM sales_document d JOIN partner p ON p.id = d.partner_id
         WHERE d.tenant_id = ${this.tenantId}
           ${filter.kind ? tx`AND d.kind = ${filter.kind}` : tx``}
           ${filter.status ? tx`AND d.status = ${filter.status}` : tx``}
           ${filter.partnerId ? tx`AND d.partner_id = ${filter.partnerId}` : tx``}
           ${filter.from ? tx`AND d.issue_date >= ${filter.from}` : tx``}
           ${filter.to ? tx`AND d.issue_date <= ${filter.to}` : tx``}
         ORDER BY d.issue_date DESC, d.created_at DESC
         LIMIT ${filter.limit ?? 200}`;
      const out: SalesDocument[] = [];
      for (const r of rows) {
        const lines = await tx`SELECT * FROM sales_document_line WHERE tenant_id = ${this.tenantId} AND document_id = ${r.id as string} ORDER BY line_no`;
        out.push(mapSalesDocument(r, lines));
      }
      return out;
    });
  }

  async get(id: string): Promise<SalesDocument> {
    return this.tx((tx) => loadSalesDocument(tx, this.tenantId, id));
  }

  /** Crée un brouillon : totaux calculés avec Money et le taux de TVA du pack à la date d'émission. */
  async createDraft(input: SalesDocumentInput, opts: { sourceDocumentId?: string } = {}): Promise<SalesDocument> {
    this.validateInput(input);
    const currency = input.currency ?? this.deps.currency;
    return this.tx(async (tx) => {
      await this.loadPartner(tx, input.partnerId);
      const resolved = await this.resolveLines(tx, input.lines, currency);
      const totals = this.totalsOf(resolved, input.issueDate, currency);
      const [d] = await tx`
        INSERT INTO sales_document (tenant_id, kind, status, partner_id, issue_date, due_date, currency, total_net, total_vat, total_gross, notes, source_document_id, created_by)
        VALUES (${this.tenantId}, ${input.kind}, 'DRAFT', ${input.partnerId}, ${input.issueDate}, ${input.dueDate ?? null}, ${currency},
                ${totals.totalNet.toString()}, ${totals.totalVat.toString()}, ${totals.totalGross.toString()}, ${input.notes ?? null},
                ${opts.sourceDocumentId ?? null}, ${this.ctx.userId})
        RETURNING id`;
      const id = d!.id as string;
      await this.insertLines(tx, id, resolved, totals);
      await this.audit(tx, "sales.draft", "sales_document", id, { kind: input.kind, totalGross: totals.totalGross.toString() });
      return loadSalesDocument(tx, this.tenantId, id);
    });
  }

  /** Remplace le contenu d'un brouillon (seul un brouillon se modifie). */
  async updateDraft(id: string, input: Partial<SalesDocumentInput>): Promise<SalesDocument> {
    return this.tx(async (tx) => {
      const cur = await loadSalesDocument(tx, this.tenantId, id, { forUpdate: true });
      if (cur.status !== "DRAFT") throw new InvoicingError("INVALID_STATUS", `Le document ${cur.number ?? id} n'est plus un brouillon ; corrigez-le par un avoir`);
      const merged: SalesDocumentInput = {
        kind: cur.kind,
        partnerId: input.partnerId ?? cur.partnerId,
        issueDate: input.issueDate ?? cur.issueDate,
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : cur.dueDate ? { dueDate: cur.dueDate } : {}),
        currency: input.currency ?? cur.currency,
        ...(input.notes !== undefined ? { notes: input.notes } : cur.notes ? { notes: cur.notes } : {}),
        lines: input.lines ?? cur.lines.map((l) => ({ ...(l.productId ? { productId: l.productId } : {}), label: l.label, quantity: l.quantity, unitPrice: l.unitPrice.toString(), accountNumber: l.accountNumber, vatCode: l.vatCode })),
      };
      this.validateInput(merged);
      await this.loadPartner(tx, merged.partnerId);
      const resolved = await this.resolveLines(tx, merged.lines, merged.currency!);
      const totals = this.totalsOf(resolved, merged.issueDate, merged.currency!);
      await tx`
        UPDATE sales_document SET partner_id = ${merged.partnerId}, issue_date = ${merged.issueDate}, due_date = ${merged.dueDate ?? null}, currency = ${merged.currency!},
               total_net = ${totals.totalNet.toString()}, total_vat = ${totals.totalVat.toString()}, total_gross = ${totals.totalGross.toString()}, notes = ${merged.notes ?? null}
         WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await tx`DELETE FROM sales_document_line WHERE tenant_id = ${this.tenantId} AND document_id = ${id}`;
      await this.insertLines(tx, id, resolved, totals);
      return loadSalesDocument(tx, this.tenantId, id);
    });
  }

  /**
   * Émission : numéro légal (continu, jamais réutilisé), certification si le pack
   * l'exige, écriture au grand livre (factures et avoirs), statut SENT. Tout est
   * dans une transaction : si l'écriture ou la certification échoue, le numéro
   * n'est pas consommé.
   */
  async issue(id: string): Promise<SalesDocument> {
    return this.tx(async (tx) => {
      const doc = await loadSalesDocument(tx, this.tenantId, id, { forUpdate: true });
      if (doc.status !== "DRAFT") throw new InvoicingError("INVALID_STATUS", `Le document ${doc.number ?? id} est déjà émis (${doc.status})`);
      if (doc.lines.length === 0) throw new InvoicingError("VALIDATION", "Un document sans ligne ne s'émet pas");
      await this.assertOpenPeriod(tx, doc.issueDate);

      const number = await this.nextNumber(tx, doc.kind, doc.issueDate);
      const numbered: SalesDocument = { ...doc, number };
      let certification: SalesDocument["certification"] = null;
      let entryId: string | null = null;

      if (doc.kind !== "QUOTE") {
        const connector = this.deps.certification;
        if (certificationRequired(this.deps.pack, doc.issueDate) && !connector?.configured) {
          throw new InvoicingError("CERTIFICATION_REQUIRED", `Le pack ${this.deps.pack.code} exige la certification (${this.deps.pack.certified_invoice?.system}) ; aucun connecteur configuré`);
        }
        if (connector?.configured) {
          try {
            certification = toCertification(this.deps.pack, await connector.certify(numbered));
          } catch (e) {
            throw new InvoicingError("CERTIFICATION_FAILED", `Certification refusée : ${(e as Error).message}`);
          }
        }
        const partner = await this.loadPartner(tx, doc.partnerId);
        const event: PostingEvent = {
          kind: doc.kind === "INVOICE" ? "SALES_INVOICE" : "SALES_CREDIT_NOTE",
          date: doc.issueDate,
          reference: number,
          label: `${doc.kind === "INVOICE" ? "Facture" : "Avoir"} ${number} ${partner.name}`,
          currency: doc.currency,
          partnerId: doc.partnerId,
          partnerAccountNumber: partner.collectiveAccount,
          lines: doc.lines.map<EventLine>((l) => ({ label: l.label, amount: l.net, accountNumber: l.accountNumber, ...(l.vatCode ? { vatCode: l.vatCode } : {}) })),
        };
        const entry = await this.deps.ledger.post(this.actor, buildEntry(event, this.template(event.kind), this.postingContext()));
        entryId = entry.id;
      }

      await tx`
        UPDATE sales_document SET number = ${number}, status = 'SENT', entry_id = ${entryId}, certification = ${certification ? tx.json(certification as never) : null}
         WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      if (doc.kind === "CREDIT_NOTE" && doc.sourceDocumentId) {
        await applyToSalesInvoice(tx, this.tenantId, doc.sourceDocumentId, { credited: doc.totalGross });
      }
      await this.audit(tx, "sales.issue", "sales_document", id, { kind: doc.kind, number, entryId, certified: Boolean(certification) });
      return loadSalesDocument(tx, this.tenantId, id);
    });
  }

  /** Annulation : brouillons seulement ; un document émis se corrige par un avoir. */
  async cancel(id: string): Promise<SalesDocument> {
    return this.tx(async (tx) => {
      const doc = await loadSalesDocument(tx, this.tenantId, id, { forUpdate: true });
      if (doc.status !== "DRAFT") throw new InvoicingError("INVALID_STATUS", `Le document ${doc.number} est émis : établissez un avoir`);
      await tx`UPDATE sales_document SET status = 'CANCELLED' WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await this.audit(tx, "sales.cancel", "sales_document", id, { status: "CANCELLED" }, { status: "DRAFT" });
      return loadSalesDocument(tx, this.tenantId, id);
    });
  }

  /** Devis accepté ou refusé par le client. */
  async setQuoteStatus(id: string, status: "ACCEPTED" | "REFUSED"): Promise<SalesDocument> {
    return this.tx(async (tx) => {
      const doc = await loadSalesDocument(tx, this.tenantId, id, { forUpdate: true });
      if (doc.kind !== "QUOTE" || doc.status !== "SENT") throw new InvoicingError("INVALID_STATUS", `Seul un devis émis s'accepte ou se refuse (${doc.kind} ${doc.status})`);
      await tx`UPDATE sales_document SET status = ${status} WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      return loadSalesDocument(tx, this.tenantId, id);
    });
  }

  /** Devis → facture (brouillon) ; le devis passe ACCEPTED. */
  async convertQuote(quoteId: string, opts: { issueDate: string; dueDate?: string }): Promise<SalesDocument> {
    assertDate(opts.issueDate, "issueDate");
    const quote = await this.get(quoteId);
    if (quote.kind !== "QUOTE") throw new InvoicingError("INVALID_STATUS", "Seul un devis se convertit en facture");
    if (!["SENT", "ACCEPTED"].includes(quote.status)) throw new InvoicingError("INVALID_STATUS", `Devis ${quote.number ?? quoteId} non émis ou refusé (${quote.status})`);
    const invoice = await this.createDraft(
      {
        kind: "INVOICE",
        partnerId: quote.partnerId,
        issueDate: opts.issueDate,
        ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
        currency: quote.currency,
        ...(quote.notes ? { notes: quote.notes } : {}),
        lines: quote.lines.map((l) => ({ ...(l.productId ? { productId: l.productId } : {}), label: l.label, quantity: l.quantity, unitPrice: l.unitPrice.toString(), accountNumber: l.accountNumber, vatCode: l.vatCode })),
      },
      { sourceDocumentId: quoteId },
    );
    await this.tx((tx) => tx`UPDATE sales_document SET status = 'ACCEPTED' WHERE tenant_id = ${this.tenantId} AND id = ${quoteId} AND status = 'SENT'`);
    return invoice;
  }

  /** Avoir (brouillon) sur une facture émise : totalité ou lignes choisies. */
  async createCreditNote(invoiceId: string, opts: { issueDate: string; lines?: SalesLineInput[]; notes?: string }): Promise<SalesDocument> {
    assertDate(opts.issueDate, "issueDate");
    const invoice = await this.get(invoiceId);
    if (invoice.kind !== "INVOICE" || !["SENT", "PARTIALLY_PAID", "PAID"].includes(invoice.status)) {
      throw new InvoicingError("INVALID_STATUS", `Un avoir ne se fait que sur une facture émise (${invoice.kind} ${invoice.status})`);
    }
    const lines = opts.lines ?? invoice.lines.map((l) => ({ ...(l.productId ? { productId: l.productId } : {}), label: l.label, quantity: l.quantity, unitPrice: l.unitPrice.toString(), accountNumber: l.accountNumber, vatCode: l.vatCode }));
    return this.createDraft(
      { kind: "CREDIT_NOTE", partnerId: invoice.partnerId, issueDate: opts.issueDate, currency: invoice.currency, notes: opts.notes ?? `Avoir sur facture ${invoice.number}`, lines },
      { sourceDocumentId: invoiceId },
    );
  }

  /** Données structurées pour le rendu PDF (module render) : document, tiers, dossier, récapitulatif TVA. */
  async getPdfData(id: string) {
    return this.tx(async (tx) => {
      const doc = await loadSalesDocument(tx, this.tenantId, id);
      const partner = await this.loadPartner(tx, doc.partnerId);
      const [company] = await tx`SELECT name, country_code, currency, tax_ids, tax_ids_enc FROM company WHERE id = ${this.tenantId}`;
      const [partnerRow] = await tx`SELECT tax_id, tax_id_enc FROM partner WHERE tenant_id = ${this.tenantId} AND id = ${doc.partnerId}`;
      // Identifiants fiscaux chiffrés au repos (docs/SECURITY.md §7) : la facture
      // les imprime, il faut donc les déchiffrer ici. La colonne en clair n'est
      // lue que tant que scripts/encrypt-tax-ids.mts n'est pas passé.
      const cipher = company?.tax_ids_enc || partnerRow?.tax_id_enc ? await existingTenantCipherIn(tx, this.tenantId) : null;
      const totals = computeDocumentTotals(
        doc.lines.map((l) => ({ amount: l.net, ...(l.vatCode ? { vatCode: l.vatCode } : {}) })),
        { pack: this.deps.pack, date: doc.issueDate, currency: doc.currency },
      );
      const source = doc.sourceDocumentId ? await tx`SELECT number, kind FROM sales_document WHERE tenant_id = ${this.tenantId} AND id = ${doc.sourceDocumentId}` : [];
      return {
        document: doc,
        company: {
          name: company?.name as string,
          countryCode: company?.country_code as string,
          currency: company?.currency as string,
          taxIds: decryptTaxIds(cipher, company?.tax_ids_enc as string | null, company?.tax_ids as Record<string, unknown> | null),
        },
        partner: { ...partner, taxId: decryptTaxId(cipher, partnerRow?.tax_id_enc as string | null, (partnerRow?.tax_id as string | null) ?? null) },
        vatSummary: totals.byVatCode.map((r) => ({ vatCode: r.vatCode, rate: r.rate, base: r.base, vat: r.vat })),
        source: source[0] ? { number: source[0].number as string, kind: source[0].kind as SalesKind } : null,
        certification: doc.certification,
        pack: { code: this.deps.pack.code, certifiedInvoiceSystem: this.deps.pack.certified_invoice?.system ?? null },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Balance âgée et relances
  // -------------------------------------------------------------------------
  /** Créances clients par tranche d'ancienneté (retard sur l'échéance à la date `asOf`). */
  async getAgedReceivables(asOf: string): Promise<AgedReport> {
    assertDate(asOf, "asOf");
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT d.partner_id, p.name AS partner_name, d.issue_date::text AS issue_date, d.due_date::text AS due_date,
               d.total_gross, d.paid_amount, d.credited_amount
          FROM sales_document d JOIN partner p ON p.id = d.partner_id
         WHERE d.tenant_id = ${this.tenantId} AND d.kind = 'INVOICE' AND d.status IN ('SENT', 'PARTIALLY_PAID') AND d.issue_date <= ${asOf}`;
      return buildAgedReport(asOf, this.deps.currency, rows);
    });
  }

  /** Factures échues non soldées, avec le dernier niveau de relance : file de relances. */
  async listOverdue(asOf: string): Promise<OverdueInvoice[]> {
    assertDate(asOf, "asOf");
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT d.id, d.number, d.partner_id, p.name AS partner_name, p.contact, d.issue_date::text AS issue_date,
               coalesce(d.due_date, d.issue_date)::text AS due_date, d.currency, d.total_gross, d.paid_amount, d.credited_amount,
               (SELECT max(level) FROM dunning x WHERE x.tenant_id = d.tenant_id AND x.sales_document_id = d.id) AS last_level,
               (SELECT max(sent_at) FROM dunning x WHERE x.tenant_id = d.tenant_id AND x.sales_document_id = d.id) AS last_sent_at
          FROM sales_document d JOIN partner p ON p.id = d.partner_id
         WHERE d.tenant_id = ${this.tenantId} AND d.kind = 'INVOICE' AND d.status IN ('SENT', 'PARTIALLY_PAID')
           AND coalesce(d.due_date, d.issue_date) < ${asOf}
         ORDER BY coalesce(d.due_date, d.issue_date), d.number`;
      return rows
        .map<OverdueInvoice>((r) => {
          const lastLevel = r.last_level === null || r.last_level === undefined ? 0 : Number(r.last_level);
          return {
            documentId: r.id as string,
            number: r.number as string,
            partnerId: r.partner_id as string,
            partnerName: r.partner_name as string,
            partnerContact: (r.contact as Record<string, unknown>) ?? {},
            issueDate: r.issue_date as string,
            dueDate: r.due_date as string,
            daysOverdue: daysBetween(r.due_date as string, asOf),
            outstanding: outstandingOf(money(r.total_gross), money(r.paid_amount), money(r.credited_amount)),
            currency: r.currency as string,
            lastDunningLevel: lastLevel,
            lastDunningAt: r.last_sent_at ? isoText(r.last_sent_at) : null,
            suggestedLevel: Math.min(lastLevel + 1, 3),
          };
        })
        .filter((o) => o.outstanding.isPositive());
    });
  }

  /**
   * Relance une facture échue : remise au canal demandé, PUIS enregistrement.
   *
   * L'ordre est le fond de cette méthode. La ligne `dunning` est ce que l'écran
   * des créances échues présente comme « relance de niveau N envoyée le … » et
   * ce sur quoi s'appuie le niveau suivant ; elle ne doit donc exister que si
   * le message a été accepté par le serveur de messagerie (ou par le canal
   * choisi). En cas d'échec, rien n'est enregistré comme envoyé — mais la
   * tentative, elle, est consignée dans `dunning_log` (statut FAILED) : on perd
   * l'envoi, jamais sa trace.
   */
  async recordDunning(documentId: string, input: DunningInput): Promise<Dunning> {
    if (!Number.isInteger(input.level) || input.level < 1 || input.level > 5) throw new InvoicingError("VALIDATION", "Niveau de relance entre 1 et 5");
    const asOf = this.today();

    // 1. Contrôles et destinataire, sans rien écrire.
    const prepared = await this.tx(async (tx) => {
      const doc = await loadSalesDocument(tx, this.tenantId, documentId);
      if (doc.kind !== "INVOICE" || !["SENT", "PARTIALLY_PAID"].includes(doc.status)) throw new InvoicingError("INVALID_STATUS", "Seule une facture non soldée se relance");
      const [partner] = await tx`SELECT name, contact FROM partner WHERE id = ${doc.partnerId} AND tenant_id = ${this.tenantId}`;
      const [company] = await tx`SELECT name, locale FROM company WHERE id = ${this.tenantId}`;
      const contact = (partner?.contact ?? {}) as Record<string, unknown>;
      const recipient = String((input.channel === "WHATSAPP" ? (contact.whatsapp ?? contact.phone) : contact.email) ?? "").trim();
      if (recipient === "") {
        throw new InvoicingError("VALIDATION", `Le tiers ${doc.partnerName} n'a pas de contact ${input.channel === "WHATSAPP" ? "WhatsApp" : "e-mail"} : la relance n'a pas de destinataire.`);
      }
      const dueDate = doc.dueDate ?? doc.issueDate;
      return {
        partnerId: doc.partnerId,
        dispatch: {
          tenantId: this.tenantId,
          documentId,
          level: input.level,
          channel: input.channel,
          recipient,
          invoiceNumber: doc.number ?? documentId,
          partnerName: doc.partnerName,
          companyName: String(company?.name ?? doc.partnerName),
          dueDate,
          daysOverdue: Math.max(daysBetween(dueDate, asOf), 0),
          outstanding: doc.outstanding.toString(),
          currency: doc.currency,
          ...(input.message ? { message: input.message } : {}),
          // Le client lit la relance : sa langue passe avant celle du dossier.
          ...(contact.locale || company?.locale ? { locale: String(contact.locale ?? company?.locale) } : {}),
        } satisfies DunningDispatch,
      };
    });

    // 2. Remise au canal. Sans expéditeur branché, on refuse : enregistrer une
    //    relance que personne n'a envoyée revient à mentir à l'utilisateur.
    const sender = this.deps.dunningSender;
    if (!sender) {
      await this.logDunningAttempt(prepared.partnerId, prepared.dispatch, "FAILED", { reason: "aucun expéditeur de relance configuré" });
      throw new InvoicingError("DUNNING_NOT_SENT", "Aucun expéditeur de relance n'est configuré : la relance n'a pas été envoyée, elle n'a donc pas été enregistrée.", {
        documentId,
        channel: input.channel,
      });
    }
    let externalId: string | undefined;
    try {
      externalId = (await sender.send(prepared.dispatch)).externalId;
    } catch (e) {
      await this.logDunningAttempt(prepared.partnerId, prepared.dispatch, "FAILED", { reason: (e as Error).message });
      throw new InvoicingError("DUNNING_NOT_SENT", `Relance non envoyée (${input.channel}) : ${(e as Error).message}`, { documentId, channel: input.channel });
    }

    // 3. Enregistrement : à partir d'ici, « envoyée » est vrai.
    return this.tx(async (tx) => {
      const [r] = await tx`
        INSERT INTO dunning (tenant_id, sales_document_id, level, channel, message, sent_by, sent_at)
        VALUES (${this.tenantId}, ${documentId}, ${input.level}, ${input.channel}, ${input.message ?? null}, ${this.ctx.userId}, ${this.now().toISOString()})
        RETURNING *`;
      await tx`
        INSERT INTO dunning_log (tenant_id, partner_id, reference, channel, level, status, detail)
        VALUES (${this.tenantId}, ${prepared.partnerId}, ${prepared.dispatch.invoiceNumber}, ${input.channel}, ${input.level}, 'SENT',
                ${tx.json({ documentId, recipient: prepared.dispatch.recipient, ...(externalId ? { externalId } : {}) })})`;
      await this.audit(tx, "dunning.send", "sales_document", documentId, { level: input.level, channel: input.channel });
      return { id: r!.id as string, salesDocumentId: documentId, level: Number(r!.level), channel: r!.channel as Dunning["channel"], sentAt: isoText(r!.sent_at), message: (r!.message as string | null) ?? null };
    });
  }

  /**
   * Consigne une tentative de relance dans `dunning_log`, hors transaction
   * métier : c'est la mémoire de ce qui a été tenté quand l'envoi a échoué.
   * Son propre échec ne masque jamais l'erreur d'origine — il s'affiche.
   */
  private async logDunningAttempt(
    partnerId: string,
    dispatch: DunningDispatch,
    status: "SENT" | "FAILED" | "SKIPPED",
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.tx(
        (tx) => tx`
          INSERT INTO dunning_log (tenant_id, partner_id, reference, channel, level, status, detail)
          VALUES (${this.tenantId}, ${partnerId}, ${dispatch.invoiceNumber}, ${dispatch.channel}, ${dispatch.level}, ${status},
                  ${tx.json({ documentId: dispatch.documentId, recipient: dispatch.recipient, ...detail })})`,
      );
    } catch (e) {
      console.warn(`[arcompt] journal des relances non écrit (facture ${dispatch.invoiceNumber}, dossier ${this.tenantId}) : ${(e as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internes
  // -------------------------------------------------------------------------
  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private assertVatCode(code: string, date: string): void {
    if (!this.deps.pack.vat.rates.some((r) => r.code === code && r.valid_from <= date && (r.valid_to === undefined || date <= r.valid_to))) {
      throw new InvoicingError("VALIDATION", `Code TVA ${code} inconnu du pack ${this.deps.pack.code} au ${date}`);
    }
  }

  private validateInput(input: SalesDocumentInput): void {
    assertDate(input.issueDate, "issueDate");
    if (input.dueDate) {
      assertDate(input.dueDate, "dueDate");
      if (input.dueDate < input.issueDate) throw new InvoicingError("VALIDATION", "L'échéance précède la date d'émission");
    }
    if (!Array.isArray(input.lines)) throw new InvoicingError("VALIDATION", "lines requis");
    for (const l of input.lines) {
      if (l.vatCode) this.assertVatCode(l.vatCode, input.issueDate);
      if (!l.productId && (!l.label || !l.accountNumber)) throw new InvoicingError("VALIDATION", "Chaque ligne sans produit exige un libellé et un compte");
    }
  }

  private async resolveLines(tx: Sql, lines: SalesLineInput[], currency: string): Promise<ResolvedLine[]> {
    const decimals = currencyDecimals(currency);
    const out: ResolvedLine[] = [];
    for (const l of lines) {
      let product: Product | null = null;
      if (l.productId) {
        const [r] = await tx`SELECT * FROM product WHERE tenant_id = ${this.tenantId} AND id = ${l.productId}`;
        if (!r) throw new InvoicingError("NOT_FOUND", `Produit ${l.productId} introuvable`);
        product = mapProduct(r);
      }
      const quantity = l.quantity ?? "1";
      if (!/^\d+(\.\d{1,4})?$/.test(quantity)) throw new InvoicingError("VALIDATION", `Quantité invalide : ${quantity}`);
      const unitPrice = l.unitPrice !== undefined ? Money.parse(l.unitPrice) : (product?.unitPrice ?? Money.zero());
      const accountNumber = l.accountNumber ?? product?.defaultAccountNumber;
      if (!accountNumber) throw new InvoicingError("VALIDATION", "Compte de produit manquant");
      const vatCode = l.vatCode === undefined ? (product?.vatCode ?? null) : l.vatCode;
      out.push({
        productId: product?.id ?? null,
        label: l.label ?? product?.label ?? "",
        quantity,
        unitPrice,
        accountNumber,
        vatCode,
        net: unitPrice.mulRate(quantity).roundTo(decimals), // HT = prix unitaire × quantité, arrondi à la devise
      });
    }
    return out;
  }

  private totalsOf(lines: ResolvedLine[], date: string, currency: string) {
    return computeDocumentTotals(
      lines.map((l) => ({ label: l.label, amount: l.net, accountNumber: l.accountNumber, ...(l.vatCode ? { vatCode: l.vatCode } : {}) })),
      { pack: this.deps.pack, date, currency },
    );
  }

  private async insertLines(tx: Sql, documentId: string, lines: ResolvedLine[], totals: ReturnType<typeof computeDocumentTotals>): Promise<void> {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const c = totals.lines[i]!;
      await tx`
        INSERT INTO sales_document_line (tenant_id, document_id, line_no, product_id, label, quantity, unit_price, account_number, vat_code, vat_rate, net, vat, gross)
        VALUES (${this.tenantId}, ${documentId}, ${i + 1}, ${l.productId}, ${l.label}, ${l.quantity}, ${l.unitPrice.toString()}, ${l.accountNumber}, ${l.vatCode},
                ${c.vatRate}, ${c.net.toString()}, ${c.vat.toString()}, ${c.gross.toString()})`;
    }
  }
}

/** Ventile des factures ouvertes par tiers et par tranche de retard. */
export function buildAgedReport(asOf: string, currency: string, rows: Record<string, unknown>[]): AgedReport {
  const zero = (): Record<AgingBucket, Money> => ({ "0-30": Money.zero(), "31-60": Money.zero(), "61-90": Money.zero(), "90+": Money.zero() });
  const byPartner = new Map<string, AgedRow>();
  const totals = zero();
  for (const r of rows) {
    const outstanding = outstandingOf(money(r.total_gross), money(r.paid_amount), money(r.credited_amount));
    if (!outstanding.isPositive()) continue;
    const due = (r.due_date as string | null) ?? (r.issue_date as string);
    const bucket = agingBucket(daysBetween(dateText(due), asOf));
    const id = r.partner_id as string;
    const row = byPartner.get(id) ?? { partnerId: id, partnerName: r.partner_name as string, buckets: zero(), total: Money.zero(), documents: 0 };
    row.buckets[bucket] = row.buckets[bucket].add(outstanding);
    row.total = row.total.add(outstanding);
    row.documents += 1;
    totals[bucket] = totals[bucket].add(outstanding);
    byPartner.set(id, row);
  }
  const list = [...byPartner.values()].sort((a, b) => b.total.cmp(a.total));
  return { asOf, currency, rows: list, totals, total: AGING_BUCKETS.reduce((a, b) => a.add(totals[b]), Money.zero()) };
}

/** Tranche d'ancienneté selon les jours de retard (non échu = 0-30). */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 30) return "0-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}
