import type { MessageChannel } from "./types.js";

/** Message sortant (demande de pièce, relance) : envoyé par WhatsApp ou e-mail. */
export interface OutboundMessage {
  channel: MessageChannel;
  to: string;
  subject?: string;
  body: string;
  /**
   * Variante HTML du corps, produite par les modèles de `@arcompt/mailer`.
   * Elle ne porte rien de plus que `body` : un canal qui l'ignore (WhatsApp)
   * ou un client qui ne l'affiche pas ne perd aucune information.
   */
  html?: string;
  tenantId: string;
  /** Identifiant métier (demande de pièce) pour la traçabilité. */
  reference?: string;
}

/** Port de notification : implémenté par le module WhatsApp / un fournisseur e-mail. */
export interface Notifier {
  send(message: OutboundMessage): Promise<{ externalId?: string }>;
}

/** Doublure de test : mémorise les messages au lieu de les envoyer. */
export class MockNotifier implements Notifier {
  readonly sent: OutboundMessage[] = [];
  failNext = false;

  async send(message: OutboundMessage): Promise<{ externalId?: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("envoi simulé en échec");
    }
    this.sent.push(message);
    return { externalId: `mock-${this.sent.length}` };
  }
}
