// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Port d'envoi d'e-mails.
 *
 * Aucun fournisseur n'est nommé ici, et aucun ne doit l'être ailleurs dans le
 * dépôt : l'expéditeur réel est un détail de configuration (`SMTP_*`,
 * `MAIL_*`). Tout service qui parle SMTP convient, ce qui est le cas de la
 * quasi-totalité d'entre eux ; changer de fournisseur ne doit demander qu'un
 * redéploiement avec d'autres variables.
 *
 * Règle de fiabilité : un échec d'envoi est TOUJOURS observable. Aucune
 * implémentation n'avale une erreur ; c'est à l'appelant de décider s'il
 * enregistre, réessaie ou refuse l'opération — et non au transport de décider
 * à sa place que « ça n'a pas marché, tant pis ».
 */

/** Message sortant, indépendant du transport. */
export interface MailAttachment { filename: string; contentType: string; contentBase64: string; }

export interface MailMessage {
  /** Destinataire unique (une adresse par message : la traçabilité est par destinataire). */
  to: string;
  subject: string;
  /** Corps en texte brut. Obligatoire : c'est la version qui doit toujours être lisible. */
  text: string;
  /** Corps HTML facultatif ; il ne doit rien porter que le texte ne porte déjà. */
  html?: string;
  /** Adresse de réponse, quand elle diffère de l'expéditeur configuré. */
  replyTo?: string;
  attachments?: MailAttachment[];
}

/** Résultat d'une remise réussie au serveur de messagerie. */
export interface MailResult {
  /** Identifiant rendu par le serveur, quand il en fournit un (traçabilité). */
  messageId?: string;
  /** Nom de l'implémentation ayant servi l'envoi (« smtp », « null »). */
  transport: string;
}

/**
 * Remise d'un message au serveur de messagerie.
 *
 * « Envoyé » veut dire « accepté par le serveur », pas « arrivé en boîte de
 * réception » : la suite dépend du fournisseur, de SPF et de DKIM
 * (voir docs/OPERATIONS.md).
 */
export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
}

export type MailErrorCode = "CONFIG" | "INVALID_MESSAGE" | "SEND_FAILED" | "TEMPLATE";

/** Erreur d'envoi ou de configuration ; jamais silencieuse. */
export class MailError extends Error {
  override name = "MailError";
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Adresse plausible : une arobase, pas d'espace, un point dans le domaine. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Contrôles communs à tous les transports : un message incomplet ne part pas. */
export function assertSendable(message: MailMessage): void {
  if (!isEmailAddress(message.to)) throw new MailError("INVALID_MESSAGE", `Adresse de destination invalide : « ${message.to} »`);
  if (message.subject.trim() === "") throw new MailError("INVALID_MESSAGE", "Objet du message vide");
  if (message.text.trim() === "") throw new MailError("INVALID_MESSAGE", "Corps du message vide");
  if (message.replyTo !== undefined && !isEmailAddress(message.replyTo)) {
    throw new MailError("INVALID_MESSAGE", `Adresse de réponse invalide : « ${message.replyTo} »`);
  }
}

/** En-tête From : « Nom <adresse> » si un nom d'affichage est configuré. */
export function formatFrom(address: string, name?: string): string {
  const display = name?.trim();
  if (!display) return address;
  // Les guillemets échappés évitent qu'une virgule dans la raison sociale
  // (« Cabinet X, SARL ») soit lue comme un second destinataire.
  return `"${display.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

/** Doublure de test : mémorise les messages au lieu de les remettre. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** Posé à true, le prochain envoi échoue (test du chemin d'erreur). */
  failNext = false;

  async send(message: MailMessage): Promise<MailResult> {
    assertSendable(message);
    if (this.failNext) {
      this.failNext = false;
      throw new MailError("SEND_FAILED", "envoi simulé en échec");
    }
    this.sent.push(message);
    return { messageId: `memory-${this.sent.length}`, transport: "memory" };
  }

  last(): MailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}
