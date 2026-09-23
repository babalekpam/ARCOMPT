import { describe, expect, it, vi } from "vitest";
import { MemoryMailer } from "@arcompt/mailer";
import type { DunningDispatch } from "@arcompt/invoicing";
import type { WhatsAppProvider } from "@arcompt/whatsapp";
import { createDunningSender, createNotifier, whatsappDunningText } from "./notifications.js";

/**
 * Branchement des canaux sortants : aucune connexion réseau, les transports
 * sont doublés. Ce qui est vérifié ici tient en une phrase : rien n'est avalé.
 */

const FOOTER = "Cabinet Exemple SARL — 01 BP 1234 Abidjan";

const whatsappDouble = (): WhatsAppProvider & { sent: Array<{ to: string; text: string }> } => {
  const sent: Array<{ to: string; text: string }> = [];
  return {
    sent,
    async sendText(to: string, text: string) {
      sent.push({ to, text });
      return { id: "wa-1" };
    },
    async sendButtons(to: string, body: string) {
      sent.push({ to, text: body });
      return { id: "wa-1" };
    },
    async downloadMedia() {
      throw new Error("non utilisé");
    },
    verifyWebhook: () => null,
    parseWebhook: () => [],
  };
};

const dispatch = (overrides: Partial<DunningDispatch> = {}): DunningDispatch => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  documentId: "22222222-2222-2222-2222-222222222222",
  level: 1,
  channel: "EMAIL",
  recipient: "client@exemple.test",
  invoiceNumber: "FAC-2025-001",
  partnerName: "Client Alpha",
  companyName: "PME Bêta",
  dueDate: "2025-01-13",
  daysOverdue: 139,
  outstanding: "800.0000",
  currency: "XOF",
  ...overrides,
});

describe("notifieur du portail", () => {
  it("un message e-mail part par l'expéditeur configuré, objet et HTML compris", async () => {
    const mailer = new MemoryMailer();
    const notifier = createNotifier({ mailer, legalFooter: FOOTER });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await notifier.send({
      channel: "EMAIL",
      to: "client@exemple.test",
      subject: "Pièce manquante",
      body: "Bonjour,\n\nMerci de nous transmettre la facture.",
      html: "<p>Bonjour,</p>",
      tenantId: "11111111-1111-1111-1111-111111111111",
      reference: "missing-document:1",
    });
    expect(result.externalId).toBe("memory-1");
    expect(mailer.last()).toMatchObject({ to: "client@exemple.test", subject: "Pièce manquante", html: "<p>Bonjour,</p>" });
  });

  it("un canal WhatsApp non configuré lève au lieu de rendre la main en silence", async () => {
    const notifier = createNotifier({ mailer: new MemoryMailer(), whatsapp: null });
    await expect(
      notifier.send({ channel: "WHATSAPP", to: "+2250700000000", body: "Bonjour", tenantId: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/WhatsApp non configuré/);
  });

  it("un échec de l'expéditeur remonte au service appelant", async () => {
    const mailer = new MemoryMailer();
    mailer.failNext = true;
    const notifier = createNotifier({ mailer });
    await expect(
      notifier.send({ channel: "EMAIL", to: "client@exemple.test", subject: "Objet", body: "Corps", tenantId: "11111111-1111-1111-1111-111111111111" }),
    ).rejects.toThrow(/échec/);
  });
});

describe("expéditeur des relances", () => {
  it("rend le modèle du niveau demandé et le remet à l'expéditeur", async () => {
    const mailer = new MemoryMailer();
    const sender = createDunningSender({ mailer, legalFooter: FOOTER });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sender.send(dispatch({ level: 3, message: "Contactez-nous avant le 30." }));
    const sent = mailer.last()!;
    expect(sent.to).toBe("client@exemple.test");
    expect(sent.subject).toBe("Mise en demeure : facture FAC-2025-001");
    expect(sent.text).toContain("800,00 XOF");
    expect(sent.text).toContain("Contactez-nous avant le 30.");
    expect(sent.text).toContain(FOOTER);
    expect(sent.text).not.toMatch(/\{\{|\}\}/);
    expect(sent.html).toContain("<p>");
  });

  it("une panne du serveur de messagerie remonte : rien ne sera enregistré comme envoyé", async () => {
    const mailer = new MemoryMailer();
    mailer.failNext = true;
    const sender = createDunningSender({ mailer, legalFooter: FOOTER });
    await expect(sender.send(dispatch())).rejects.toThrow(/échec/);
    expect(mailer.sent).toHaveLength(0);
  });

  it("WhatsApp reçoit une version courte ; sans fournisseur, la relance est refusée", async () => {
    const wa = whatsappDouble();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createDunningSender({ mailer: new MemoryMailer(), whatsapp: wa, legalFooter: FOOTER }).send(dispatch({ channel: "WHATSAPP", recipient: "+2250700000000" }));
    expect(wa.sent[0]?.to).toBe("+2250700000000");
    expect(wa.sent[0]?.text).toContain("FAC-2025-001");
    expect(whatsappDunningText(dispatch({ channel: "WHATSAPP", level: 3 })).startsWith("Mise en demeure")).toBe(true);

    await expect(
      createDunningSender({ mailer: new MemoryMailer(), whatsapp: null }).send(dispatch({ channel: "WHATSAPP", recipient: "+2250700000000" })),
    ).rejects.toThrow(/WhatsApp non configuré/);
  });

  it("le canal SMS n'est pas implémenté : il est refusé, pas simulé", async () => {
    await expect(createDunningSender({ mailer: new MemoryMailer() }).send(dispatch({ channel: "SMS", recipient: "+2250700000000" }))).rejects.toThrow(/SMS/);
  });
});
