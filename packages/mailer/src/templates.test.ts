import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEGAL_FOOTER,
  adminAccessMail,
  breakGlassMail,
  dunningMail,
  fill,
  formatAmountFr,
  formatDateFr,
  formatDateTimeFr,
  htmlFromText,
  invitationMail,
  legalFooterFromEnv,
  missingDocumentMail,
  type RenderedMail,
} from "./index.js";

const FOOTER = "Cabinet Exemple SARL — 01 BP 1234 Abidjan — RCCM CI-ABJ-2020-B-1234 — compta@exemple.test";

/** Texte visible d'un HTML : sert à prouver qu'il ne dit rien de plus que le texte. */
function textOf(html: string): string {
  return html
    .replace(/<br \/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Contrôles communs à tout message : aucun marqueur, le motif et les mentions légales. */
function expectWellFormed(mail: RenderedMail): void {
  expect(mail.subject).not.toMatch(/\{\{|\}\}/);
  expect(mail.text).not.toMatch(/\{\{|\}\}/);
  expect(mail.html).not.toMatch(/\{\{|\}\}/);
  expect(mail.text).toContain("Vous recevez ce message");
  expect(mail.text.trimEnd().endsWith(FOOTER)).toBe(true);
  // Le HTML se réduit au texte : chaque ligne non vide du texte s'y retrouve.
  const visible = textOf(mail.html);
  for (const line of mail.text.split("\n").map((l) => l.trim())) {
    if (line !== "" && line !== "--") expect(visible).toContain(line);
  }
}

describe("substitution des variables", () => {
  it("remplace les marqueurs et refuse toute variable absente ou vide", () => {
    expect(fill("Facture {{n}} du {{d}}", { n: "FAC-1", d: "01/06/2025" })).toBe("Facture FAC-1 du 01/06/2025");
    expect(() => fill("Facture {{n}}", {})).toThrow(/n/);
    expect(() => fill("Facture {{n}}", { n: "   " })).toThrow(/Variables de modèle absentes/);
    expect(() => fill("{{a}} {{b}}", { a: "x" })).toThrow(/b/);
  });

  it("le HTML échappe ce que le texte contient", () => {
    const html = htmlFromText('Cabinet "A" & Associés <compta@exemple.test>\n\nhttps://portail.exemple.test/accepter');
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;compta@exemple.test&gt;");
    expect(html).toContain('<a href="https://portail.exemple.test/accepter">');
    expect(html).not.toContain("<compta@");
  });

  it("dates et montants sont mis au format local", () => {
    expect(formatDateFr("2025-06-01")).toBe("01/06/2025");
    expect(formatDateFr("2025-06-01T12:30:00.000Z")).toBe("01/06/2025");
    expect(formatDateTimeFr("2025-06-01T12:30:00.000Z")).toBe("01/06/2025 à 12:30 UTC");
    expect(formatAmountFr("1234567.8900", "XOF")).toBe("1\u00a0234\u00a0567,89\u00a0XOF");
    expect(formatAmountFr("800.0000", "XOF")).toBe("800,00\u00a0XOF");
  });

  it("le pied de page légal a un texte de rappel tant qu'il n'est pas configuré", () => {
    expect(legalFooterFromEnv({})).toBe(DEFAULT_LEGAL_FOOTER);
    expect(legalFooterFromEnv({ MAIL_LEGAL_FOOTER: "  " })).toBe(DEFAULT_LEGAL_FOOTER);
    expect(legalFooterFromEnv({ MAIL_LEGAL_FOOTER: FOOTER })).toBe(FOOTER);
  });
});

describe("modèles de messages", () => {
  it("invitation : lien, code à usage unique et expiration", () => {
    const mail = invitationMail({
      organizationName: "Cabinet Exemple",
      role: "ACCOUNTANT",
      companyCount: 2,
      acceptUrl: "https://portail.exemple.test/firm/members",
      token: "jeton-a-usage-unique",
      expiresAt: "2025-06-03T12:00:00.000Z",
      legalFooter: FOOTER,
    });
    expectWellFormed(mail);
    expect(mail.subject).toBe("Invitation à rejoindre Cabinet Exemple sur ARCOMPT");
    expect(mail.text).toContain("https://portail.exemple.test/firm/members");
    expect(mail.text).toContain("jeton-a-usage-unique");
    expect(mail.text).toContain("comptable");
    expect(mail.text).toContain("2 dossiers");
    expect(mail.text).toContain("03/06/2025 à 12:00 UTC");
    expect(invitationMail({
      organizationName: "Cabinet Exemple",
      role: "OWNER",
      companyCount: 1,
      acceptUrl: "https://portail.exemple.test/firm/members",
      token: "t",
      expiresAt: "2025-06-03T12:00:00.000Z",
      legalFooter: FOOTER,
    }).text).toContain("1 dossier");
  });

  it("demande de pièce : expéditeur, dossier et pièce demandée", () => {
    const mail = missingDocumentMail({
      partnerName: "Client Alpha",
      senderName: "Cabinet Exemple",
      companyName: "PME Bêta",
      description: "Facture FAC-2025-001 signée",
      legalFooter: FOOTER,
    });
    expectWellFormed(mail);
    expect(mail.subject).toBe("Cabinet Exemple : pièce manquante pour PME Bêta");
    expect(mail.text).toContain("Bonjour Client Alpha,");
    expect(mail.text).toContain("Cabinet Exemple a besoin");
    expect(mail.text).toContain("Facture FAC-2025-001 signée");
    // Tiers inconnu : la formule d'appel reste correcte, sans marqueur vide.
    const anonyme = missingDocumentMail({ senderName: "Cabinet Exemple", companyName: "PME Bêta", description: "Relevé bancaire", legalFooter: FOOTER });
    expect(anonyme.text.startsWith("Bonjour,")).toBe(true);
    expectWellFormed(anonyme);
  });

  it("accès administrateur et accès d'urgence : deux messages distincts", () => {
    const ordinaire = adminAccessMail({ companyName: "PME Bêta", accessedAt: "2025-06-01T09:05:00.000Z", reason: "Reconstruction d'un index corrompu", legalFooter: FOOTER });
    expectWellFormed(ordinaire);
    expect(ordinaire.subject).toBe("Accès technique à votre dossier PME Bêta");
    expect(ordinaire.text).toContain("un technicien a accédé à votre dossier");
    expect(ordinaire.text).toContain("Reconstruction d'un index corrompu");
    expect(ordinaire.text).toContain("01/06/2025 à 09:05 UTC");

    const urgence = breakGlassMail({
      companyName: "PME Bêta",
      accessedAt: "2025-06-01T09:05:00.000Z",
      reason: "Incident de production",
      expiresAt: "2025-06-01T13:05:00.000Z",
      legalFooter: FOOTER,
    });
    expectWellFormed(urgence);
    expect(urgence.subject).toBe("Accès d'urgence à votre dossier PME Bêta");
    expect(urgence.text).toContain("un technicien a accédé à votre dossier");
    expect(urgence.text).toContain("approuvé par un second");
    expect(urgence.text).toContain("13:05 UTC");
  });

  it("relances : un ton par niveau, la mise en demeure au-delà du troisième", () => {
    const base = {
      partnerName: "Client Alpha",
      companyName: "PME Bêta",
      invoiceNumber: "FAC-2025-001",
      dueDate: "2025-01-13",
      daysOverdue: 139,
      outstanding: "800.0000",
      currency: "XOF",
      legalFooter: FOOTER,
    };
    const n1 = dunningMail({ ...base, level: 1 });
    expectWellFormed(n1);
    expect(n1.subject).toBe("Rappel : facture FAC-2025-001 échue");
    expect(n1.text).toContain("800,00\u00a0XOF");
    expect(n1.text).toContain("13/01/2025");
    expect(n1.text).toContain("139 jour(s) de retard");

    expect(dunningMail({ ...base, level: 2 }).subject).toBe("Relance : facture FAC-2025-001 toujours impayée");
    const n3 = dunningMail({ ...base, level: 3 });
    expect(n3.subject).toBe("Mise en demeure : facture FAC-2025-001");
    expect(n3.text).toContain("mettons en demeure");
    expect(dunningMail({ ...base, level: 5 }).subject).toBe(n3.subject);
    expectWellFormed(dunningMail({ ...base, level: 5 }));

    // Le mot ajouté par le cabinet reste avant le motif et les mentions légales.
    const avecMot = dunningMail({ ...base, level: 2, message: "Nous restons à votre disposition pour un échéancier." });
    expectWellFormed(avecMot);
    expect(avecMot.text).toContain("Nous restons à votre disposition pour un échéancier.");
    expect(avecMot.text.indexOf("Nous restons")).toBeLessThan(avecMot.text.indexOf("Vous recevez ce message"));
  });

  it("une variable obligatoire absente empêche l'envoi plutôt que de laisser un marqueur", () => {
    expect(() =>
      dunningMail({
        level: 1,
        partnerName: "",
        companyName: "PME Bêta",
        invoiceNumber: "FAC-2025-001",
        dueDate: "2025-01-13",
        daysOverdue: 139,
        outstanding: "800.0000",
        currency: "XOF",
        legalFooter: FOOTER,
      }),
    ).toThrow(/partnerName/);
  });
});
