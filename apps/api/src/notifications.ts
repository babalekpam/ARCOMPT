// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createMailerFromEnv, dunningMail, legalFooterFromEnv, normalizeLocale, type Mailer } from "@arcompt/mailer";
import type { DunningDispatch, DunningSender } from "@arcompt/invoicing";
import type { Notifier, OutboundMessage } from "@arcompt/portal";
import type { WhatsAppProvider } from "@arcompt/whatsapp";
import { log } from "./telemetry.js";

/**
 * Branchement des canaux sortants sur les modules métier.
 *
 * Deux ports, une seule règle : un envoi qui échoue lève. C'est l'appelant
 * métier qui décide ensuite (le portail enregistre la demande de pièce sans
 * `sent_at` et répond NOTIFY_FAILED ; la facturation n'écrit pas la ligne de
 * relance). Rien n'est avalé ici.
 *
 * Aucun fournisseur n'est nommé : l'expéditeur vient de `createMailerFromEnv`,
 * donc des variables `SMTP_*` / `MAIL_*`.
 */

export interface ChannelOptions {
  mailer: Mailer;
  /** Fournisseur WhatsApp, quand il est configuré (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID`). */
  whatsapp?: WhatsAppProvider | null;
  /** Mentions légales en pied des e-mails ; défaut : `MAIL_LEGAL_FOOTER`. */
  legalFooter?: string;
}

/** Expéditeur e-mail configuré par l'environnement, avec journalisation structurée des avertissements. */
export function createMailer(opts: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): Mailer {
  return createMailerFromEnv({
    ...(opts.env ? { env: opts.env } : {}),
    warn: (message: string) => {
      if (!opts.quiet) log("warn", "mail.simulated", { detail: message });
    },
  });
}

/**
 * Port `Notifier` du portail : e-mail par le `Mailer`, WhatsApp par le
 * fournisseur Meta quand il est configuré.
 *
 * Un canal non configuré lève au lieu de rendre la main en silence : c'est
 * exactement ce que faisait l'ancien notifieur anonyme de `routes/portal.ts`,
 * qui journalisait « non envoyé » puis laissait le portail écrire `sent_at`.
 */
export function createNotifier(opts: ChannelOptions): Notifier {
  return {
    async send(message: OutboundMessage): Promise<{ externalId?: string }> {
      if (message.channel === "EMAIL") {
        const result = await opts.mailer.send({
          to: message.to,
          subject: message.subject ?? "ARCOMPT",
          text: message.body,
          ...(message.html ? { html: message.html } : {}),
        });
        log("info", "notify.email.sent", { reference: message.reference ?? null, tenantId: message.tenantId, transport: result.transport });
        return { ...(result.messageId ? { externalId: result.messageId } : {}) };
      }
      if (!opts.whatsapp) {
        throw new Error("Canal WhatsApp non configuré (WHATSAPP_TOKEN et WHATSAPP_PHONE_ID absents) : le message n'a pas été envoyé.");
      }
      const sent = await opts.whatsapp.sendText(message.to, message.body);
      log("info", "notify.whatsapp.sent", { reference: message.reference ?? null, tenantId: message.tenantId });
      return { externalId: sent.id };
    },
  };
}

/** Une relance WhatsApp tient sur un écran de téléphone ; le détail reste dans la facture. */
export function whatsappDunningText(d: DunningDispatch): string {
  // Même langue que la relance par e-mail : un client qui reçoit les deux ne
  // doit pas les recevoir dans deux langues.
  const locale = normalizeLocale(d.locale) ?? "fr";
  if (locale === "en") {
    const head = d.level <= 1 ? "Reminder" : d.level === 2 ? "Second reminder" : "Formal notice";
    return [
      `${head} — invoice ${d.invoiceNumber} from ${d.companyName}.`,
      `Dear ${d.partnerName}, this invoice fell due on ${d.dueDate} (${d.daysOverdue} day(s) ago). Amount outstanding: ${d.outstanding} ${d.currency}.`,
      d.message?.trim() ? d.message.trim() : "Please let us know when payment will be made.",
    ].join("\n");
  }
  const head = d.level <= 1 ? "Rappel" : d.level === 2 ? "Relance" : "Mise en demeure";
  return [
    `${head} — facture ${d.invoiceNumber} de ${d.companyName}.`,
    `Bonjour ${d.partnerName}, cette facture est échue depuis le ${d.dueDate} (${d.daysOverdue} jour(s)). Reste dû : ${d.outstanding} ${d.currency}.`,
    d.message?.trim() ? d.message.trim() : "Merci de nous indiquer la date de règlement.",
  ].join("\n");
}

/**
 * Port `DunningSender` de la facturation. L'erreur remonte toujours : c'est ce
 * qui garantit qu'une ligne `dunning` — affichée comme « relance de niveau N
 * envoyée le … » — n'existe que si le message est parti.
 */
export function createDunningSender(opts: ChannelOptions): DunningSender {
  const legalFooter = opts.legalFooter ?? legalFooterFromEnv();
  return {
    async send(dispatch: DunningDispatch): Promise<{ externalId?: string }> {
      if (dispatch.channel === "EMAIL") {
        const mail = dunningMail({
          level: dispatch.level,
          partnerName: dispatch.partnerName,
          companyName: dispatch.companyName,
          invoiceNumber: dispatch.invoiceNumber,
          dueDate: dispatch.dueDate,
          daysOverdue: dispatch.daysOverdue,
          outstanding: dispatch.outstanding,
          currency: dispatch.currency,
          ...(dispatch.message ? { message: dispatch.message } : {}),
          // Langue du CLIENT relancé, résolue par le service à partir de son
          // contact puis du dossier. Absente, le gabarit retombe sur le français.
          ...(dispatch.locale ? { locale: dispatch.locale } : {}),
          legalFooter,
        });
        const result = await opts.mailer.send({ to: dispatch.recipient, subject: mail.subject, text: mail.text, html: mail.html });
        log("info", "dunning.sent", { tenantId: dispatch.tenantId, invoice: dispatch.invoiceNumber, level: dispatch.level, channel: "EMAIL", transport: result.transport });
        return { ...(result.messageId ? { externalId: result.messageId } : {}) };
      }
      if (dispatch.channel === "WHATSAPP") {
        if (!opts.whatsapp) throw new Error("Canal WhatsApp non configuré (WHATSAPP_TOKEN et WHATSAPP_PHONE_ID absents).");
        const sent = await opts.whatsapp.sendText(dispatch.recipient, whatsappDunningText(dispatch));
        log("info", "dunning.sent", { tenantId: dispatch.tenantId, invoice: dispatch.invoiceNumber, level: dispatch.level, channel: "WHATSAPP" });
        return { externalId: sent.id };
      }
      // Aucun opérateur SMS n'est implémenté : la relance est refusée, jamais
      // enregistrée comme partie.
      throw new Error("Canal SMS non implémenté : aucune passerelle SMS n'est configurée dans ARCOMPT.");
    },
  };
}
