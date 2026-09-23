import { describe, expect, it } from "vitest";
import {
  createMailerFromEnv,
  MailError,
  MAIL_OPT_OUT,
  MemoryMailer,
  NullMailer,
  SmtpMailer,
  formatFrom,
  smtpOptionsFromEnv,
  type SmtpTransport,
} from "./index.js";

/**
 * Aucun test n'ouvre de connexion : `SmtpMailer` reçoit un transport doublé, et
 * les fabriques ne construisent rien tant qu'aucun message n'est envoyé.
 */

type SentMail = Parameters<SmtpTransport["sendMail"]>[0];

/** Transport doublé : mémorise, ou échoue, sans réseau. */
class FakeTransport implements SmtpTransport {
  readonly sent: SentMail[] = [];
  constructor(private readonly behaviour: { throws?: Error; rejected?: string[] } = {}) {}
  async sendMail(mail: SentMail) {
    this.sent.push(mail);
    if (this.behaviour.throws) throw this.behaviour.throws;
    return { messageId: "<id@serveur>", accepted: [mail.to], rejected: this.behaviour.rejected ?? [], response: "250 OK" };
  }
}

const SMTP_ENV = {
  SMTP_HOST: "smtp.exemple.test",
  SMTP_PORT: "587",
  SMTP_USER: "expediteur",
  SMTP_PASSWORD: "secret",
  MAIL_FROM_ADDRESS: "compta@exemple.test",
  MAIL_FROM_NAME: "Cabinet Exemple",
} satisfies NodeJS.ProcessEnv;

const silent = () => {};

describe("choix du transport selon l'environnement", () => {
  it("SMTP dès que l'hôte et l'adresse d'expédition sont renseignés", () => {
    const mailer = createMailerFromEnv({ env: { ...SMTP_ENV, NODE_ENV: "production" }, warn: silent });
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it("hors production, repli sur l'expéditeur neutre avec un avertissement", () => {
    const warnings: string[] = [];
    const mailer = createMailerFromEnv({ env: { NODE_ENV: "development" }, warn: (m) => warnings.push(m) });
    expect(mailer).toBeInstanceOf(NullMailer);
    expect(warnings.join("\n")).toContain("SIMULATION");
  });

  it("en production, le repli neutre est refusé et l'erreur nomme l'opt-out", () => {
    let thrown: unknown;
    try {
      createMailerFromEnv({ env: { NODE_ENV: "production" }, warn: silent });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MailError);
    expect((thrown as MailError).code).toBe("CONFIG");
    expect((thrown as MailError).message).toContain("SMTP_HOST");
    expect((thrown as MailError).message).toContain(MAIL_OPT_OUT);
  });

  it("en production, l'opt-out explicite autorise l'expéditeur neutre", () => {
    const mailer = createMailerFromEnv({ env: { NODE_ENV: "production", [MAIL_OPT_OUT]: "1" }, warn: silent });
    expect(mailer).toBeInstanceOf(NullMailer);
  });

  it("une configuration à moitié posée lève, même hors production", () => {
    expect(() => createMailerFromEnv({ env: { NODE_ENV: "development", SMTP_HOST: "smtp.exemple.test" }, warn: silent })).toThrow(/MAIL_FROM_ADDRESS/);
  });

  it("TLS implicite déduit du port, et forçable par SMTP_SECURE", () => {
    expect(smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_PORT: "465" })?.secure).toBe(true);
    expect(smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_PORT: "587" })?.secure).toBe(false);
    expect(smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_PORT: "2525", SMTP_SECURE: "yes" })?.secure).toBe(true);
    expect(smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_PORT: "465", SMTP_SECURE: "0" })?.secure).toBe(false);
    expect(smtpOptionsFromEnv({})).toBeNull();
    expect(() => smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_PORT: "port" })).toThrow(/SMTP_PORT/);
  });
});

describe("remise SMTP", () => {
  const options = (transport: SmtpTransport) => ({
    host: "smtp.exemple.test",
    port: 587,
    secure: false,
    user: "expediteur",
    password: "secret",
    fromAddress: "compta@exemple.test",
    fromName: "Cabinet Exemple, SARL",
    transport,
  });

  it("transmet objet, corps, HTML et adresse de réponse, et rend l'identifiant du serveur", async () => {
    const transport = new FakeTransport();
    const mailer = new SmtpMailer(options(transport));
    const result = await mailer.send({
      to: "client@exemple.test",
      subject: "Rappel : facture FAC-2025-001 échue",
      text: "Bonjour,",
      html: "<p>Bonjour,</p>",
      replyTo: "cabinet@exemple.test",
    });
    expect(result).toEqual({ messageId: "<id@serveur>", transport: "smtp" });
    expect(transport.sent[0]).toMatchObject({
      from: '"Cabinet Exemple, SARL" <compta@exemple.test>',
      to: "client@exemple.test",
      subject: "Rappel : facture FAC-2025-001 échue",
      html: "<p>Bonjour,</p>",
      replyTo: "cabinet@exemple.test",
    });
  });

  it("un échec du serveur remonte à l'appelant et n'est jamais avalé", async () => {
    const transport = new FakeTransport({ throws: new Error("ECONNREFUSED 10.0.0.1:587") });
    const mailer = new SmtpMailer(options(transport));
    const failure = await mailer.send({ to: "client@exemple.test", subject: "Objet", text: "Corps" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MailError);
    expect((failure as MailError).code).toBe("SEND_FAILED");
    expect((failure as MailError).message).toContain("client@exemple.test");
    expect((failure as MailError).details).toMatchObject({ cause: "ECONNREFUSED 10.0.0.1:587" });
  });

  it("un destinataire refusé n'est pas un envoi réussi", async () => {
    const transport = new FakeTransport({ rejected: ["client@exemple.test"] });
    const mailer = new SmtpMailer(options(transport));
    await expect(mailer.send({ to: "client@exemple.test", subject: "Objet", text: "Corps" })).rejects.toMatchObject({ code: "SEND_FAILED" });
  });

  it("un message incomplet ne touche pas le transport", async () => {
    const transport = new FakeTransport();
    const mailer = new SmtpMailer(options(transport));
    await expect(mailer.send({ to: "pas-une-adresse", subject: "Objet", text: "Corps" })).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    await expect(mailer.send({ to: "client@exemple.test", subject: "  ", text: "Corps" })).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    await expect(mailer.send({ to: "client@exemple.test", subject: "Objet", text: " " })).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    expect(transport.sent).toHaveLength(0);
  });

  it("une adresse d'expédition invalide est refusée à la construction", () => {
    expect(() => new SmtpMailer({ ...options(new FakeTransport()), fromAddress: "cabinet" })).toThrow(/MAIL_FROM_ADDRESS/);
  });

  it("l'en-tête From échappe les guillemets du nom d'affichage", () => {
    expect(formatFrom("compta@exemple.test")).toBe("compta@exemple.test");
    expect(formatFrom("compta@exemple.test", 'Cabinet "A"')).toBe('"Cabinet \\"A\\"" <compta@exemple.test>');
  });
});

describe("expéditeurs de développement et de test", () => {
  it("l'expéditeur neutre journalise tout le message et dit qu'il n'est pas parti", async () => {
    const lines: string[] = [];
    const mailer = new NullMailer((l) => lines.push(l));
    await mailer.send({ to: "client@exemple.test", subject: "Objet", text: "Ligne 1\nLigne 2" });
    const printed = lines.join("\n");
    expect(printed).toContain("N'EST PAS parti");
    expect(printed).toContain("client@exemple.test");
    expect(printed).toContain("Ligne 2");
    expect(mailer.last()?.subject).toBe("Objet");
  });

  it("la doublure mémoire sait échouer à la demande", async () => {
    const mailer = new MemoryMailer();
    mailer.failNext = true;
    await expect(mailer.send({ to: "client@exemple.test", subject: "Objet", text: "Corps" })).rejects.toBeInstanceOf(MailError);
    await mailer.send({ to: "client@exemple.test", subject: "Objet", text: "Corps" });
    expect(mailer.sent).toHaveLength(1);
  });
});
