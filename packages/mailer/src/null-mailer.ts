import { assertSendable, type Mailer, type MailMessage, type MailResult } from "./mailer.js";

/**
 * Expéditeur neutre du développement : rien ne part, tout est écrit sur la
 * sortie standard, en entier — objet, destinataire et corps. Le message reste
 * donc lisible par la personne qui développe (elle peut suivre le lien d'une
 * invitation depuis son terminal), et personne ne peut confondre cela avec un
 * envoi réel.
 *
 * `createMailerFromEnv` refuse de le servir en production sans l'opt-out
 * explicite `ALLOW_INSECURE_MAIL=1`.
 */
export class NullMailer implements Mailer {
  private seq = 0;
  /** Messages « envoyés » depuis le démarrage : utile en test et en revue locale. */
  readonly sent: MailMessage[] = [];

  constructor(private readonly write: (line: string) => void = (line) => console.warn(line)) {}

  async send(message: MailMessage): Promise<MailResult> {
    assertSendable(message);
    this.sent.push(message);
    const id = `null-${++this.seq}`;
    this.write(
      [
        `[arcompt] SIMULATION : aucun serveur de messagerie configuré, ce message N'EST PAS parti (${id}).`,
        `  À        : ${message.to}`,
        `  Objet    : ${message.subject}`,
        ...(message.replyTo ? [`  Réponse  : ${message.replyTo}`] : []),
        ...message.text.split("\n").map((l) => `  | ${l}`),
      ].join("\n"),
    );
    return { messageId: id, transport: "null" };
  }

  last(): MailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}
