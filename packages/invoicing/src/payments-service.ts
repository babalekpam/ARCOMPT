// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { Money } from "@arcompt/ledger";
import { buildEntry, type PostingEvent } from "@arcompt/posting";
import { BaseService, EVENT_KIND_BY_PAYMENT, InvoicingError, assertDate } from "./base.js";
import { applyToPurchaseInvoice, applyToSalesInvoice, loadPurchaseDocument, loadSalesDocument } from "./documents.js";
import { mapPayment, mapPaymentLink } from "./mappers.js";
import { WEBHOOK_MAX_SKEW_SECONDS, WebhookSignatureError, type WebhookEvent, type WebhookHeaders } from "./payment-provider.js";
import type { AllocationInput, Payment, PaymentInput, PaymentKind, PaymentLink, PaymentMethod, PaymentStatus, WebhookOutcome } from "./types.js";

/** Compte de trésorerie par défaut selon la méthode de règlement. */
export const TREASURY_BY_METHOD: Record<PaymentMethod, string> = {
  BANK: "521",
  CHEQUE: "521",
  CASH: "571",
  MOBILE_MONEY: "5381",
};

export interface PaymentListFilter {
  kind?: PaymentKind;
  status?: PaymentStatus;
  partnerId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** Affectation validée : document verrouillé, montant borné par le reste à régler. */
interface CheckedAllocation {
  salesDocumentId: string | null;
  purchaseDocumentId: string | null;
  amount: Money;
  /** Créateur du document d'achat (séparation des tâches à l'approbation). */
  documentCreatedBy: string | null;
}

/**
 * Règlements : encaissements et décaissements (banque, caisse, mobile money,
 * chèque), affectations aux factures, double validation au-delà du seuil,
 * liens de paiement et webhooks signés.
 */
export class PaymentsService extends BaseService {
  async list(filter: PaymentListFilter = {}): Promise<Payment[]> {
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT * FROM payment
         WHERE tenant_id = ${this.tenantId}
           ${filter.kind ? tx`AND kind = ${filter.kind}` : tx``}
           ${filter.status ? tx`AND status = ${filter.status}` : tx``}
           ${filter.partnerId ? tx`AND partner_id = ${filter.partnerId}` : tx``}
           ${filter.from ? tx`AND payment_date >= ${filter.from}` : tx``}
           ${filter.to ? tx`AND payment_date <= ${filter.to}` : tx``}
         ORDER BY payment_date DESC, created_at DESC
         LIMIT ${filter.limit ?? 200}`;
      const out: Payment[] = [];
      for (const r of rows) out.push(await this.hydrate(tx, r));
      return out;
    });
  }

  async get(id: string): Promise<Payment> {
    return this.tx((tx) => this.load(tx, id));
  }

  /**
   * Enregistre un règlement. Sous le seuil : écriture posée et affectations
   * appliquées immédiatement (RECORDED). Au-delà (≥ seuil) : PENDING_APPROVAL,
   * rien n'atteint le grand livre avant `approve()` par un autre utilisateur.
   */
  async record(input: PaymentInput): Promise<Payment> {
    assertDate(input.date, "date");
    const amount = Money.parse(input.amount);
    if (!amount.isPositive()) throw new InvoicingError("VALIDATION", "Le montant du règlement doit être positif");
    const treasury = input.treasuryAccountNumber ?? TREASURY_BY_METHOD[input.method];
    if (!/^5\d{1,12}$/.test(treasury)) throw new InvoicingError("VALIDATION", `Compte de trésorerie invalide : ${treasury}`);
    return this.tx(async (tx) => {
      const partner = await this.loadPartner(tx, input.partnerId);
      const allocations = await this.checkAllocations(tx, input.kind, input.partnerId, amount, input.allocations ?? []);
      const threshold = await this.approvalThreshold(tx);
      const needsApproval = amount.cmp(threshold) >= 0;
      const number = await this.nextNumber(tx, "PAYMENT", input.date);
      const entryId = needsApproval ? null : await this.postEntry(input.kind, { date: input.date, number, reference: input.reference, amount, currency: this.deps.currency, treasury, partnerId: input.partnerId, partnerName: partner.name, partnerAccount: partner.collectiveAccount });
      const [p] = await tx`
        INSERT INTO payment (tenant_id, kind, method, number, treasury_account_number, partner_id, amount, currency, payment_date, reference, entry_id,
                             provider, provider_tx_id, status, created_by)
        VALUES (${this.tenantId}, ${input.kind}, ${input.method}, ${number}, ${treasury}, ${input.partnerId}, ${amount.toString()}, ${this.deps.currency},
                ${input.date}, ${input.reference ?? null}, ${entryId}, ${input.provider ?? null}, ${input.providerTxId ?? null},
                ${needsApproval ? "PENDING_APPROVAL" : "RECORDED"}, ${this.ctx.userId})
        RETURNING id`;
      const id = p!.id as string;
      await this.insertAllocations(tx, id, allocations);
      if (!needsApproval) await this.applyAllocations(tx, allocations);
      await this.audit(tx, needsApproval ? "payment.pending_approval" : "payment.record", "payment", id, { number, kind: input.kind, amount: amount.toString(), threshold: threshold.toString(), entryId });
      return this.load(tx, id);
    });
  }

  /**
   * Approbation par un second utilisateur (OWNER ou ACCOUNTANT, contrôlé par
   * l'API) : différent du créateur du règlement et du créateur de tout document
   * d'achat réglé. Pose l'écriture et applique les affectations. Un règlement en
   * REVIEW (écart webhook) s'approuve de la même façon, jamais automatiquement.
   */
  async approve(id: string, opts: { allocations?: AllocationInput[] } = {}): Promise<Payment> {
    return this.tx(async (tx) => {
      const cur = await this.load(tx, id, { forUpdate: true });
      if (cur.status !== "PENDING_APPROVAL" && cur.status !== "REVIEW") throw new InvoicingError("INVALID_STATUS", `Le règlement ${cur.number} n'attend pas d'approbation (${cur.status})`);
      if (cur.createdBy === this.ctx.userId) throw new InvoicingError("SAME_USER", "Séparation des tâches : l'approbateur doit être différent de l'auteur du règlement");
      const partner = await this.loadPartner(tx, cur.partnerId);
      let allocations: CheckedAllocation[];
      if (opts.allocations) {
        await tx`DELETE FROM payment_allocation WHERE tenant_id = ${this.tenantId} AND payment_id = ${id}`;
        allocations = await this.checkAllocations(tx, cur.kind, cur.partnerId, cur.amount, opts.allocations);
        await this.insertAllocations(tx, id, allocations);
      } else {
        allocations = await this.checkAllocations(tx, cur.kind, cur.partnerId, cur.amount, cur.allocations.map((a) => ({ ...(a.salesDocumentId ? { salesDocumentId: a.salesDocumentId } : {}), ...(a.purchaseDocumentId ? { purchaseDocumentId: a.purchaseDocumentId } : {}), amount: a.amount.toString() })));
      }
      const sameAuthor = allocations.find((a) => a.documentCreatedBy === this.ctx.userId);
      if (sameAuthor) throw new InvoicingError("SAME_USER", `Séparation des tâches : l'approbateur a saisi le document d'achat ${sameAuthor.purchaseDocumentId}`);
      await this.assertOpenPeriod(tx, cur.date);
      const entryId = await this.postEntry(cur.kind, { date: cur.date, number: cur.number, reference: cur.reference ?? undefined, amount: cur.amount, currency: cur.currency, treasury: cur.treasuryAccountNumber, partnerId: cur.partnerId, partnerName: partner.name, partnerAccount: partner.collectiveAccount });
      const approvedAt = this.now().toISOString();
      await tx`UPDATE payment SET status = 'RECORDED', entry_id = ${entryId}, approved_by = ${this.ctx.userId}, approved_at = ${approvedAt} WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await this.applyAllocations(tx, allocations);
      await this.audit(tx, "payment.approve", "payment", id, { entryId, approvedBy: this.ctx.userId, previousStatus: cur.status }, { status: cur.status });
      return this.load(tx, id);
    });
  }

  /** Refus d'un règlement en attente ou en revue : jamais comptabilisé. */
  async reject(id: string, reason: string): Promise<Payment> {
    return this.tx(async (tx) => {
      const cur = await this.load(tx, id, { forUpdate: true });
      if (cur.status !== "PENDING_APPROVAL" && cur.status !== "REVIEW") throw new InvoicingError("INVALID_STATUS", `Le règlement ${cur.number} ne se refuse pas (${cur.status})`);
      await tx`UPDATE payment SET status = 'REJECTED', review_reason = ${reason} WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
      await this.audit(tx, "payment.reject", "payment", id, { reason }, { status: cur.status });
      return this.load(tx, id);
    });
  }

  /** Affecte le reliquat non affecté d'un règlement comptabilisé à des factures. */
  async allocate(paymentId: string, allocations: AllocationInput[]): Promise<Payment> {
    return this.tx(async (tx) => {
      const cur = await this.load(tx, paymentId, { forUpdate: true });
      if (cur.status !== "RECORDED") throw new InvoicingError("INVALID_STATUS", `Le règlement ${cur.number} n'est pas comptabilisé (${cur.status})`);
      const remaining = cur.amount.sub(cur.allocated);
      const checked = await this.checkAllocations(tx, cur.kind, cur.partnerId, remaining, allocations);
      await this.insertAllocations(tx, paymentId, checked);
      await this.applyAllocations(tx, checked);
      await this.audit(tx, "payment.allocate", "payment", paymentId, { allocations: checked.map((a) => ({ sales: a.salesDocumentId, purchase: a.purchaseDocumentId, amount: a.amount.toString() })) });
      return this.load(tx, paymentId);
    });
  }

  // -------------------------------------------------------------------------
  // Mobile money : lien de paiement et webhook
  // -------------------------------------------------------------------------
  async createPaymentLink(salesDocumentId: string, providerName: string): Promise<PaymentLink> {
    const provider = this.deps.paymentProviders?.[providerName];
    if (!provider) throw new InvoicingError("PROVIDER_UNKNOWN", `Opérateur de paiement ${providerName} inconnu`);
    return this.tx(async (tx) => {
      const doc = await loadSalesDocument(tx, this.tenantId, salesDocumentId);
      if (doc.kind !== "INVOICE" || !["SENT", "PARTIALLY_PAID"].includes(doc.status) || !doc.outstanding.isPositive()) {
        throw new InvoicingError("INVALID_STATUS", `Un lien de paiement exige une facture émise non soldée (${doc.kind} ${doc.status})`);
      }
      const partner = await this.loadPartner(tx, doc.partnerId);
      const phone = typeof partner.contact.phone === "string" ? partner.contact.phone : undefined;
      const link = await provider.createPaymentLink({ documentId: doc.id, amount: doc.outstanding.toString(), currency: doc.currency, reference: doc.number!, customerName: partner.name, ...(phone ? { customerPhone: phone } : {}) });
      const [r] = await tx`
        INSERT INTO payment_link (tenant_id, sales_document_id, provider, provider_ref, url, amount, currency, expires_at)
        VALUES (${this.tenantId}, ${salesDocumentId}, ${provider.name}, ${link.providerRef}, ${link.url}, ${doc.outstanding.toString()}, ${doc.currency}, ${link.expiresAt ?? null})
        RETURNING *`;
      await this.audit(tx, "payment_link.create", "sales_document", salesDocumentId, { provider: provider.name, providerRef: link.providerRef, amount: doc.outstanding.toString() });
      return mapPaymentLink(r!);
    });
  }

  async listPaymentLinks(salesDocumentId: string): Promise<PaymentLink[]> {
    return this.tx(async (tx) => (await tx`SELECT * FROM payment_link WHERE tenant_id = ${this.tenantId} AND sales_document_id = ${salesDocumentId} ORDER BY created_at DESC`).map(mapPaymentLink));
  }

  /**
   * Webhook de confirmation. Ordre des contrôles (docs/SECURITY.md §7, §9) :
   *  1. signature HMAC vérifiée par l'opérateur sur le corps brut → sinon 401 et
   *     `webhook.invalid_signature` dans audit_log ;
   *  2. horodatage dans la tolérance et nonce jamais vu → sinon rejeu (409) journalisé ;
   *  3. idempotence stricte par identifiant d'événement → doublon sans effet ;
   *  4. rapprochement montant / devise attendus (lien) et reste à régler de la
   *     facture → tout écart crée un règlement en REVIEW, jamais d'écriture.
   */
  async handleWebhook(providerName: string, rawBody: string, headers: WebhookHeaders): Promise<WebhookOutcome> {
    const provider = this.deps.paymentProviders?.[providerName];
    if (!provider) throw new InvoicingError("PROVIDER_UNKNOWN", `Opérateur de paiement ${providerName} inconnu`);
    let event: WebhookEvent | null;
    try {
      event = await provider.handleWebhook(rawBody, headers);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        await this.tx((tx) => this.audit(tx, "webhook.invalid_signature", "webhook", providerName, { provider: providerName, reason: e.message, bodyLength: rawBody.length }));
        throw new InvoicingError("INVALID_SIGNATURE", "Webhook rejeté : signature invalide");
      }
      throw e;
    }
    if (!event) return { outcome: "ignored", eventId: null, payment: null };

    const skew = Math.abs(Math.floor(this.now().getTime() / 1000) - event.timestamp);
    if (!Number.isFinite(skew) || skew > WEBHOOK_MAX_SKEW_SECONDS) {
      await this.tx((tx) => this.audit(tx, "webhook.replay", "webhook", event.eventId, { provider: providerName, reason: "timestamp", skew }));
      throw new InvoicingError("REPLAY", "Webhook rejeté : horodatage hors tolérance");
    }

    return this.tx(async (tx): Promise<WebhookOutcome> => {
      const [dup] = await tx`SELECT payment_id FROM webhook_event WHERE tenant_id = ${this.tenantId} AND provider = ${providerName} AND event_id = ${event.eventId}`;
      if (dup) return { outcome: "duplicate", eventId: event.eventId, payment: dup.payment_id ? await this.load(tx, dup.payment_id as string) : null };
      const [seen] = await tx`SELECT 1 FROM webhook_event WHERE tenant_id = ${this.tenantId} AND provider = ${providerName} AND nonce = ${event.nonce}`;
      // Nonce déjà vu : rejeu. L'audit doit survivre au rejet, il est écrit hors transaction (voir catch).
      if (seen) throw new ReplayMarker();
      const [we] = await tx`
        INSERT INTO webhook_event (tenant_id, provider, event_id, nonce, status, payload)
        VALUES (${this.tenantId}, ${providerName}, ${event.eventId}, ${event.nonce}, 'IGNORED', ${tx.json(JSON.parse(rawBody) as never)})
        RETURNING id`;
      const webhookEventId = we!.id as string;

      const [linkRow] = await tx`SELECT * FROM payment_link WHERE tenant_id = ${this.tenantId} AND provider = ${providerName} AND provider_ref = ${event.providerRef} FOR UPDATE`;
      if (!linkRow) {
        await this.audit(tx, "webhook.unknown_link", "webhook", event.eventId, { provider: providerName, providerRef: event.providerRef });
        return { outcome: "ignored", eventId: event.eventId, payment: null };
      }
      const link = mapPaymentLink(linkRow);
      if (event.status !== "PAID") {
        await tx`UPDATE payment_link SET status = 'FAILED' WHERE tenant_id = ${this.tenantId} AND id = ${link.id}`;
        return { outcome: "ignored", eventId: event.eventId, payment: null };
      }

      const invoice = await loadSalesDocument(tx, this.tenantId, link.salesDocumentId, { forUpdate: true });
      const received = Money.parse(event.amount);
      const [linkCreator] = await tx`SELECT user_id FROM audit_log WHERE tenant_id = ${this.tenantId} AND action = 'payment_link.create' AND entity_id = ${link.salesDocumentId} ORDER BY id DESC LIMIT 1`;
      const createdBy = (linkCreator?.user_id as string | null) ?? this.ctx.userId;
      const reasons: string[] = [];
      if (!received.eq(link.amount)) reasons.push(`montant reçu ${received.toString()} ≠ attendu ${link.amount.toString()}`);
      if (event.currency !== link.currency) reasons.push(`devise ${event.currency} ≠ ${link.currency}`);
      if (link.status === "PAID") reasons.push("lien déjà réglé");
      if (!["SENT", "PARTIALLY_PAID"].includes(invoice.status) || received.cmp(invoice.outstanding) > 0) reasons.push(`reste à régler ${invoice.outstanding.toString()} sur la facture ${invoice.number}`);

      const date = (event.paidAt ?? this.now().toISOString()).slice(0, 10);
      const number = await this.nextNumber(tx, "PAYMENT", date);
      const partner = await this.loadPartner(tx, invoice.partnerId);
      const treasury = TREASURY_BY_METHOD.MOBILE_MONEY;

      if (reasons.length > 0) {
        const [p] = await tx`
          INSERT INTO payment (tenant_id, kind, method, number, treasury_account_number, partner_id, amount, currency, payment_date, reference,
                               provider, provider_tx_id, provider_event_id, status, review_reason, created_by)
          VALUES (${this.tenantId}, 'RECEIPT', 'MOBILE_MONEY', ${number}, ${treasury}, ${invoice.partnerId}, ${received.isPositive() ? received.toString() : link.amount.toString()}, ${event.currency},
                  ${date}, ${event.providerRef}, ${providerName}, ${event.providerTxId}, ${event.eventId}, 'REVIEW', ${reasons.join(" ; ")}, ${createdBy})
          RETURNING id`;
        const id = p!.id as string;
        if (["SENT", "PARTIALLY_PAID"].includes(invoice.status) && invoice.outstanding.isPositive()) {
          await tx`INSERT INTO payment_allocation (tenant_id, payment_id, sales_document_id, amount) VALUES (${this.tenantId}, ${id}, ${invoice.id}, ${(received.cmp(invoice.outstanding) > 0 ? invoice.outstanding : received).toString()})`;
        }
        await tx`UPDATE webhook_event SET status = 'REVIEW', payment_id = ${id} WHERE id = ${webhookEventId}`;
        await this.audit(tx, "payment.review", "payment", id, { provider: providerName, eventId: event.eventId, reasons });
        return { outcome: "review", eventId: event.eventId, payment: await this.load(tx, id) };
      }

      const threshold = await this.approvalThreshold(tx);
      const needsApproval = received.cmp(threshold) >= 0;
      const entryId = needsApproval ? null : await this.postEntry("RECEIPT", { date, number, reference: event.providerRef, amount: received, currency: link.currency, treasury, partnerId: invoice.partnerId, partnerName: partner.name, partnerAccount: partner.collectiveAccount });
      const [p] = await tx`
        INSERT INTO payment (tenant_id, kind, method, number, treasury_account_number, partner_id, amount, currency, payment_date, reference, entry_id,
                             provider, provider_tx_id, provider_event_id, status, created_by)
        VALUES (${this.tenantId}, 'RECEIPT', 'MOBILE_MONEY', ${number}, ${treasury}, ${invoice.partnerId}, ${received.toString()}, ${link.currency}, ${date}, ${event.providerRef}, ${entryId},
                ${providerName}, ${event.providerTxId}, ${event.eventId}, ${needsApproval ? "PENDING_APPROVAL" : "RECORDED"}, ${createdBy})
        RETURNING id`;
      const id = p!.id as string;
      const allocation: CheckedAllocation = { salesDocumentId: invoice.id, purchaseDocumentId: null, amount: received, documentCreatedBy: null };
      await this.insertAllocations(tx, id, [allocation]);
      if (!needsApproval) await this.applyAllocations(tx, [allocation]);
      await tx`UPDATE payment_link SET status = 'PAID', payment_id = ${id} WHERE tenant_id = ${this.tenantId} AND id = ${link.id}`;
      await tx`UPDATE webhook_event SET status = 'PROCESSED', payment_id = ${id} WHERE id = ${webhookEventId}`;
      await this.audit(tx, needsApproval ? "payment.pending_approval" : "payment.record", "payment", id, { provider: providerName, eventId: event.eventId, amount: received.toString(), entryId });
      return { outcome: "processed", eventId: event.eventId, payment: await this.load(tx, id) };
    }).catch(async (e) => {
      if (e instanceof ReplayMarker) {
        await this.tx((tx) => this.audit(tx, "webhook.replay", "webhook", event!.eventId, { provider: providerName, reason: "nonce" }));
        throw new InvoicingError("REPLAY", "Webhook rejeté : nonce déjà utilisé");
      }
      throw e;
    });
  }

  // -------------------------------------------------------------------------
  // Internes
  // -------------------------------------------------------------------------
  private async load(tx: Sql, id: string, opts: { forUpdate?: boolean } = {}): Promise<Payment> {
    const rows = opts.forUpdate
      ? await tx`SELECT * FROM payment WHERE tenant_id = ${this.tenantId} AND id = ${id} FOR UPDATE`
      : await tx`SELECT * FROM payment WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    if (!rows[0]) throw new InvoicingError("NOT_FOUND", `Règlement ${id} introuvable`);
    return this.hydrate(tx, rows[0]);
  }

  private async hydrate(tx: Sql, r: Record<string, unknown>): Promise<Payment> {
    const allocations = await tx`SELECT * FROM payment_allocation WHERE tenant_id = ${this.tenantId} AND payment_id = ${r.id as string} ORDER BY created_at`;
    return mapPayment(r, allocations);
  }

  /** Pose l'écriture de trésorerie via le moteur d'imputation ; retourne l'identifiant de l'écriture. */
  private async postEntry(kind: PaymentKind, p: { date: string; number: string; reference?: string | undefined; amount: Money; currency: string; treasury: string; partnerId: string; partnerName: string; partnerAccount: string }): Promise<string> {
    const eventKind = EVENT_KIND_BY_PAYMENT[kind];
    const event: PostingEvent = {
      kind: eventKind,
      date: p.date,
      reference: p.number,
      label: `${kind === "RECEIPT" ? "Encaissement" : "Décaissement"} ${p.number} ${p.partnerName}${p.reference ? ` (${p.reference})` : ""}`,
      currency: p.currency,
      partnerId: p.partnerId,
      partnerAccountNumber: p.partnerAccount,
      treasuryAccountNumber: p.treasury,
      amounts: { amount: p.amount },
    };
    const entry = await this.deps.ledger.post(this.actor, buildEntry(event, this.template(eventKind), this.postingContext()));
    return entry.id;
  }

  /** Vérifie chaque affectation : document du bon type et du même tiers, montant borné, somme ≤ disponible. */
  private async checkAllocations(tx: Sql, kind: PaymentKind, partnerId: string, available: Money, inputs: AllocationInput[]): Promise<CheckedAllocation[]> {
    const out: CheckedAllocation[] = [];
    let total = Money.zero();
    for (const a of inputs) {
      const amount = Money.parse(a.amount);
      if (!amount.isPositive()) throw new InvoicingError("VALIDATION", "Une affectation doit être positive");
      if (Boolean(a.salesDocumentId) === Boolean(a.purchaseDocumentId)) throw new InvoicingError("VALIDATION", "Une affectation vise exactement un document (vente ou achat)");
      if (a.salesDocumentId) {
        if (kind !== "RECEIPT") throw new InvoicingError("VALIDATION", "Un décaissement ne s'affecte pas à une facture de vente");
        const doc = await loadSalesDocument(tx, this.tenantId, a.salesDocumentId, { forUpdate: true });
        if (doc.kind !== "INVOICE" || !["SENT", "PARTIALLY_PAID"].includes(doc.status)) throw new InvoicingError("INVALID_STATUS", `La facture ${doc.number ?? doc.id} n'est pas réglable (${doc.kind} ${doc.status})`);
        if (doc.partnerId !== partnerId) throw new InvoicingError("PARTNER_MISMATCH", `La facture ${doc.number} n'appartient pas au tiers du règlement`);
        if (amount.cmp(doc.outstanding) > 0) throw new InvoicingError("OVER_ALLOCATION", `Affectation ${amount.toString()} > reste à régler ${doc.outstanding.toString()} sur ${doc.number}`);
        out.push({ salesDocumentId: doc.id, purchaseDocumentId: null, amount, documentCreatedBy: null });
      } else {
        if (kind !== "DISBURSEMENT") throw new InvoicingError("VALIDATION", "Un encaissement ne s'affecte pas à une facture d'achat");
        const doc = await loadPurchaseDocument(tx, this.tenantId, a.purchaseDocumentId!, { forUpdate: true });
        if (doc.kind === "SUPPLIER_CREDIT_NOTE" || !["POSTED", "PARTIALLY_PAID"].includes(doc.status)) throw new InvoicingError("INVALID_STATUS", `Le document ${doc.number ?? doc.id} n'est pas réglable (${doc.kind} ${doc.status})`);
        if (doc.partnerId !== partnerId) throw new InvoicingError("PARTNER_MISMATCH", `Le document ${doc.number} n'appartient pas au tiers du règlement`);
        if (amount.cmp(doc.outstanding) > 0) throw new InvoicingError("OVER_ALLOCATION", `Affectation ${amount.toString()} > reste à payer ${doc.outstanding.toString()} sur ${doc.number}`);
        const [creator] = await tx`SELECT created_by FROM purchase_document WHERE tenant_id = ${this.tenantId} AND id = ${doc.id}`;
        out.push({ salesDocumentId: null, purchaseDocumentId: doc.id, amount, documentCreatedBy: (creator?.created_by as string) ?? null });
      }
      total = total.add(amount);
    }
    if (total.cmp(available) > 0) throw new InvoicingError("OVER_ALLOCATION", `Affectations ${total.toString()} > montant disponible ${available.toString()}`);
    return out;
  }

  private async insertAllocations(tx: Sql, paymentId: string, allocations: CheckedAllocation[]): Promise<void> {
    for (const a of allocations) {
      await tx`INSERT INTO payment_allocation (tenant_id, payment_id, sales_document_id, purchase_document_id, amount) VALUES (${this.tenantId}, ${paymentId}, ${a.salesDocumentId}, ${a.purchaseDocumentId}, ${a.amount.toString()})`;
    }
  }

  /** Met à jour le réglé et le statut des factures visées (uniquement pour un règlement comptabilisé). */
  private async applyAllocations(tx: Sql, allocations: CheckedAllocation[]): Promise<void> {
    for (const a of allocations) {
      if (a.salesDocumentId) await applyToSalesInvoice(tx, this.tenantId, a.salesDocumentId, { paid: a.amount });
      else if (a.purchaseDocumentId) await applyToPurchaseInvoice(tx, this.tenantId, a.purchaseDocumentId, { paid: a.amount });
    }
  }
}

/** Signal interne : rejeu détecté dans la transaction (l'audit est réécrit hors transaction). */
class ReplayMarker extends Error {}

