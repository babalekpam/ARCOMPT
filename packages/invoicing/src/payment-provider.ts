// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface PaymentLinkRequest {
  /** Identifiant interne du document (facture). */
  documentId: string;
  amount: string;
  currency: string;
  /** Référence affichée au payeur (numéro de facture). */
  reference: string;
  customerName?: string;
  customerPhone?: string;
}

export interface PaymentLinkResult {
  providerRef: string;
  url: string;
  expiresAt?: string;
}

/** Notification de paiement normalisée, issue du webhook de l'opérateur. */
export interface WebhookEvent {
  /** Identifiant unique de l'événement chez l'opérateur : clé d'idempotence. */
  eventId: string;
  providerRef: string;
  providerTxId: string;
  amount: string;
  currency: string;
  status: "PAID" | "FAILED";
  /** Horodatage signé (secondes Unix) et nonce : protection contre le rejeu. */
  timestamp: number;
  nonce: string;
  paidAt?: string;
  payerPhone?: string;
}

/** En-têtes HTTP en minuscules, tels que reçus par la route webhook. */
export type WebhookHeaders = Record<string, string | undefined>;

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

/**
 * Opérateur de paiement (mobile money, agrégateur). L'API réelle (Wave, Orange
 * Money, MTN MoMo, CinetPay…) est branchée derrière cette interface ; le module
 * ne connaît que le lien de paiement et l'événement de confirmation vérifié.
 */
export interface PaymentProvider {
  readonly name: string;
  createPaymentLink(input: PaymentLinkRequest): Promise<PaymentLinkResult>;
  /**
   * Vérifie la signature HMAC du corps brut puis normalise l'événement.
   * Lève `WebhookSignatureError` si la signature est absente ou invalide ;
   * retourne null si la charge n'est pas un événement de paiement (ping).
   * La fraîcheur de l'horodatage et l'unicité du nonce sont contrôlées par le
   * service (`PaymentsService.handleWebhook`), pas par l'opérateur.
   */
  handleWebhook(rawBody: string, headers: WebhookHeaders): Promise<WebhookEvent | null>;
}

/** Tolérance d'horodatage des webhooks (secondes). */
export const WEBHOOK_MAX_SKEW_SECONDS = 300;

/** Signature HMAC-SHA256 hexadécimale de `timestamp.nonce.rawBody`. */
export function signWebhook(secret: string, timestamp: number | string, nonce: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
}

/** Comparaison en temps constant de deux signatures hexadécimales. */
export function verifyWebhookSignature(secret: string, timestamp: string | undefined, nonce: string | undefined, rawBody: string, signature: string | undefined): boolean {
  if (!timestamp || !nonce || !signature || !/^\d+$/.test(timestamp)) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, nonce, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && given.length > 0 && timingSafeEqual(expected, given);
}

/**
 * Opérateur simulé : les liens sont gardés en mémoire ; le webhook est un JSON
 * `{ eventId, providerRef, txId, amount, currency, status }` signé par HMAC dans
 * les en-têtes `x-signature`, `x-timestamp`, `x-nonce`.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name: string;
  readonly links = new Map<string, PaymentLinkRequest & PaymentLinkResult>();

  constructor(
    opts: { name?: string; secret?: string; baseUrl?: string } = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.name = opts.name ?? "mock";
    this.secret = opts.secret ?? "mock-secret";
    this.baseUrl = opts.baseUrl ?? "https://pay.mock.local";
  }

  private readonly secret: string;
  private readonly baseUrl: string;

  async createPaymentLink(input: PaymentLinkRequest): Promise<PaymentLinkResult> {
    const providerRef = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const result = { providerRef, url: `${this.baseUrl}/${providerRef}` };
    this.links.set(providerRef, { ...input, ...result });
    return result;
  }

  async handleWebhook(rawBody: string, headers: WebhookHeaders): Promise<WebhookEvent | null> {
    const timestamp = headers["x-timestamp"];
    const nonce = headers["x-nonce"];
    if (!verifyWebhookSignature(this.secret, timestamp, nonce, rawBody, headers["x-signature"])) {
      throw new WebhookSignatureError("Signature de webhook invalide");
    }
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookSignatureError("Corps de webhook illisible");
    }
    if (typeof p.eventId !== "string" || typeof p.providerRef !== "string" || typeof p.txId !== "string") return null;
    const link = this.links.get(p.providerRef);
    return {
      eventId: p.eventId,
      providerRef: p.providerRef,
      providerTxId: p.txId,
      amount: typeof p.amount === "string" ? p.amount : (link?.amount ?? "0"),
      currency: typeof p.currency === "string" ? p.currency : (link?.currency ?? "XOF"),
      status: p.status === "FAILED" ? "FAILED" : "PAID",
      timestamp: Number(timestamp),
      nonce: nonce!,
      ...(typeof p.paidAt === "string" ? { paidAt: p.paidAt } : {}),
      ...(typeof p.payerPhone === "string" ? { payerPhone: p.payerPhone } : {}),
    };
  }

  /**
   * Fabrique une livraison signée comme l'enverrait l'opérateur (tests, simulateur) :
   * corps brut et en-têtes. `overrides` permet de forger un montant ou un statut.
   */
  signedDelivery(providerRef: string, overrides: Record<string, unknown> = {}, opts: { timestamp?: number; nonce?: string; secret?: string } = {}): { rawBody: string; headers: WebhookHeaders } {
    const link = this.links.get(providerRef);
    const body = { eventId: `EVT-${randomUUID()}`, providerRef, txId: `TX-${randomUUID().slice(0, 8)}`, amount: link?.amount, currency: link?.currency, status: "PAID", ...overrides };
    const rawBody = JSON.stringify(body);
    const timestamp = opts.timestamp ?? Math.floor(this.now().getTime() / 1000);
    const nonce = opts.nonce ?? randomUUID();
    return { rawBody, headers: { "x-timestamp": String(timestamp), "x-nonce": nonce, "x-signature": signWebhook(opts.secret ?? this.secret, timestamp, nonce, rawBody) } };
  }
}
