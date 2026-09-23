import type { DunningChannel } from "./types.js";

/**
 * Port d'envoi des relances.
 *
 * Le module facturation sait QUOI relancer et à qui ; il ne sait pas comment
 * un message part. L'application branche ici l'expéditeur réel (e-mail par
 * `@arcompt/mailer`, WhatsApp par `@arcompt/whatsapp`).
 *
 * Contrat, et raison d'être de ce port : `recordDunning` n'écrit sa ligne
 * `dunning` — celle que l'écran des créances échues présente comme « relance
 * de niveau N envoyée le … » — qu'APRÈS un `send()` revenu sans erreur. Une
 * erreur remonte donc toujours, et empêche l'enregistrement.
 */
export interface DunningDispatch {
  tenantId: string;
  documentId: string;
  /** 1 = rappel, 2 = relance, 3 et au-delà = mise en demeure. */
  level: number;
  channel: DunningChannel;
  /** Destinataire pour le canal demandé : adresse e-mail, ou numéro WhatsApp. */
  recipient: string;
  /** Numéro de la facture relancée. */
  invoiceNumber: string;
  /** Client relancé. */
  partnerName: string;
  /** Dossier émetteur de la facture. */
  companyName: string;
  /** Échéance dépassée (AAAA-MM-JJ). */
  dueDate: string;
  daysOverdue: number;
  /** Reste dû, décimal. */
  outstanding: string;
  currency: string;
  /** Mot ajouté par le cabinet, facultatif. */
  message?: string;
}

export interface DunningSender {
  /** Remet la relance au canal demandé. Toute erreur remonte à l'appelant. */
  send(dispatch: DunningDispatch): Promise<{ externalId?: string }>;
}

/** Doublure de test : mémorise les relances au lieu de les envoyer. */
export class MemoryDunningSender implements DunningSender {
  readonly sent: DunningDispatch[] = [];
  /** Posé à true, le prochain envoi échoue (test du chemin d'erreur). */
  failNext = false;

  async send(dispatch: DunningDispatch): Promise<{ externalId?: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("envoi simulé en échec");
    }
    this.sent.push(dispatch);
    return { externalId: `memory-${this.sent.length}` };
  }

  last(): DunningDispatch | undefined {
    return this.sent[this.sent.length - 1];
  }
}
