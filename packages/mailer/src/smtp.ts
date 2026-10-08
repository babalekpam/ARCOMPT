// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import nodemailer from "nodemailer";
import { assertSendable, formatFrom, isEmailAddress, MailError, type Mailer, type MailMessage, type MailResult } from "./mailer.js";

/**
 * Transport SMTP, construit sur nodemailer.
 *
 * Aucun fournisseur n'est nommé ni supposé : hôte, port, identifiants et
 * adresse d'expédition viennent de l'environnement. Le port 465 impose TLS dès
 * la connexion (`SMTP_SECURE=1`) ; 587 et 25 ouvrent en clair puis passent en
 * TLS par STARTTLS, exigé ici (`requireTLS`) pour qu'un mot de passe ne parte
 * jamais en clair si le serveur « oublie » de le proposer.
 */

/** Ce que l'on attend d'un transport : de quoi injecter une doublure en test. */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
  }): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }>;
  /**
   * Ouvre la session et s'authentifie sans rien expédier. Facultatif : une
   * doublure de test n'a rien à vérifier.
   */
  verify?(): Promise<unknown>;
}

export interface SmtpMailerOptions {
  host: string;
  /** 465 (TLS implicite), 587 ou 25 (STARTTLS). */
  port: number;
  /** TLS dès l'ouverture de la connexion (port 465). */
  secure: boolean;
  user?: string;
  password?: string;
  /** Adresse d'expédition ; c'est elle que SPF et DKIM doivent autoriser. */
  fromAddress: string;
  fromName?: string;
  /** Adresse de réponse par défaut, quand le message n'en porte pas. */
  replyTo?: string;
  /** Transport déjà construit (tests) : aucune connexion réseau n'est alors ouverte. */
  transport?: SmtpTransport;
  /** Délai maximal d'une remise, en millisecondes (défaut 20 000). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_SMTP_PORT = 587;
/** Port sur lequel TLS est implicite ; sert de valeur par défaut à SMTP_SECURE. */
export const IMPLICIT_TLS_PORT = 465;

export class SmtpMailer implements Mailer {
  private transport: SmtpTransport | undefined;

  constructor(private readonly opts: SmtpMailerOptions) {
    if (opts.host.trim() === "") throw new MailError("CONFIG", "SMTP_HOST : hôte du serveur de messagerie vide.");
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new MailError("CONFIG", `SMTP_PORT : port invalide (${opts.port}).`);
    }
    if (!isEmailAddress(opts.fromAddress)) {
      throw new MailError("CONFIG", `MAIL_FROM_ADDRESS : adresse d'expédition invalide (« ${opts.fromAddress} »).`);
    }
    if (opts.replyTo !== undefined && !isEmailAddress(opts.replyTo)) {
      throw new MailError("CONFIG", `MAIL_REPLY_TO : adresse de réponse invalide (« ${opts.replyTo} »).`);
    }
    this.transport = opts.transport;
  }

  /** Construit le transport au premier envoi : rien n'est ouvert tant que rien n'est envoyé. */
  private connection(): SmtpTransport {
    if (!this.transport) {
      const timeout = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.transport = nodemailer.createTransport({
        host: this.opts.host,
        port: this.opts.port,
        secure: this.opts.secure,
        // Sur un port en clair, on exige STARTTLS plutôt que de l'espérer.
        requireTLS: !this.opts.secure,
        ...(this.opts.user ? { auth: { user: this.opts.user, pass: this.opts.password ?? "" } } : {}),
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
      }) as unknown as SmtpTransport;
    }
    return this.transport;
  }

  /**
   * Éprouve la connexion et l'authentification, sans expédier de message.
   *
   * Sert au contrôle d'exploitation (scripts/check-mail.mts) : un relais mal
   * configuré ne se voit pas autrement qu'en perdant une invitation réelle.
   * Séparé de `send()` à dessein — une authentification acceptée ne prouve pas
   * qu'un message sorte, et confondre les deux ferait chercher l'erreur au
   * mauvais endroit.
   *
   * Le transport est celui que l'application utilise pour de bon : mêmes délais,
   * même exigence de STARTTLS. Vérifier autre chose ne vérifierait rien.
   */
  async verify(): Promise<void> {
    const transport = this.connection();
    if (!transport.verify) return; // doublure de test : rien à ouvrir
    try {
      await transport.verify();
    } catch (e) {
      throw new MailError("CONFIG", `Connexion SMTP impossible vers ${this.opts.host}:${this.opts.port} : ${(e as Error).message}`, {
        host: this.opts.host,
        port: this.opts.port,
        secure: this.opts.secure,
        cause: (e as Error).message,
      });
    }
  }

  async send(message: MailMessage): Promise<MailResult> {
    assertSendable(message);
    const from = formatFrom(this.opts.fromAddress, this.opts.fromName);
    const replyTo = message.replyTo ?? this.opts.replyTo;
    let info: Awaited<ReturnType<SmtpTransport["sendMail"]>>;
    try {
      info = await this.connection().sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType })) } : {}),
      });
    } catch (e) {
      // L'erreur remonte toujours : c'est l'appelant qui décide quoi faire de
      // l'opération métier (refuser, journaliser l'échec, réessayer).
      throw new MailError("SEND_FAILED", `Remise SMTP impossible vers ${message.to} : ${(e as Error).message}`, {
        host: this.opts.host,
        port: this.opts.port,
        cause: (e as Error).message,
      });
    }
    // Un serveur peut accepter la session et refuser le destinataire : ce n'est
    // pas un envoi réussi, et cela ne doit pas être enregistré comme tel.
    if (info.rejected && info.rejected.length > 0) {
      throw new MailError("SEND_FAILED", `Destinataire refusé par le serveur de messagerie : ${message.to}`, {
        rejected: info.rejected.map(String),
        response: info.response ?? null,
      });
    }
    return { ...(info.messageId ? { messageId: info.messageId } : {}), transport: "smtp" };
  }
}

/** `1`, `true`, `yes` (insensible à la casse) activent un drapeau ; tout le reste le laisse fermé. */
export function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Lit la configuration SMTP de l'environnement, ou renvoie null si aucun
 * serveur n'est configuré (SMTP_HOST absent).
 *
 * Une configuration à moitié posée n'est pas un repli : `SMTP_HOST` sans
 * `MAIL_FROM_ADDRESS` lève, en production comme ailleurs, plutôt que de
 * retomber en silence sur l'expéditeur neutre.
 */
export function smtpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpMailerOptions | null {
  if (!present(env.SMTP_HOST)) return null;
  if (!present(env.MAIL_FROM_ADDRESS)) {
    throw new MailError("CONFIG", "MAIL_FROM_ADDRESS : absente alors que SMTP_HOST est renseigné — un serveur d'envoi sans adresse d'expéditeur ne peut rien remettre.");
  }
  const port = present(env.SMTP_PORT) ? Number(env.SMTP_PORT) : DEFAULT_SMTP_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new MailError("CONFIG", `SMTP_PORT : port invalide (« ${env.SMTP_PORT} »).`);
  }
  return {
    host: env.SMTP_HOST.trim(),
    port,
    // Sans SMTP_SECURE, le port décide : 465 = TLS implicite, sinon STARTTLS.
    secure: present(env.SMTP_SECURE) ? isFlagEnabled(env.SMTP_SECURE) : port === IMPLICIT_TLS_PORT,
    ...(present(env.SMTP_USER) ? { user: env.SMTP_USER.trim() } : {}),
    ...(present(env.SMTP_PASSWORD) ? { password: env.SMTP_PASSWORD } : {}),
    fromAddress: env.MAIL_FROM_ADDRESS.trim(),
    ...(present(env.MAIL_FROM_NAME) ? { fromName: env.MAIL_FROM_NAME.trim() } : {}),
    ...(present(env.MAIL_REPLY_TO) ? { replyTo: env.MAIL_REPLY_TO.trim() } : {}),
  };
}
