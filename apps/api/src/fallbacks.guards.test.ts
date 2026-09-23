// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockFneConnector, NullConnector } from "@arcompt/invoicing";
import { ConfigError, certificationConnectorFromEnv, paymentProvidersFromEnv } from "./config.js";
import { invoicingRoutes } from "./routes/invoicing.js";
import { publicWebhookRoutes } from "./routes/public-webhooks.js";
import { resetWhatsAppProvider, whatsappRoutes } from "./routes/whatsapp.js";

/**
 * Garde-fous des points de repli de l'API : en production, aucun simulateur ne
 * peut être choisi silencieusement ; hors production, le comportement actuel
 * est conservé et un avertissement nomme ce qui est simulé.
 */

const deps = { auth: { mode: "dev" as const }, quiet: true, ledgerFor: () => ({}) } as never;

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetWhatsAppProvider();
  vi.restoreAllMocks();
});

describe("opérateur de paiement", () => {
  it("refuse en production le simulateur explicitement réclamé", () => {
    expect(() => paymentProvidersFromEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "mock", PAYMENT_WEBHOOK_SECRET: "x".repeat(48) }, () => {})).toThrow(ConfigError);
    try {
      paymentProvidersFromEnv({ NODE_ENV: "production", PAYMENT_PROVIDER: "mock" }, () => {});
    } catch (e) {
      expect((e as Error).message).toContain("PAYMENT_PROVIDER");
      expect((e as Error).message).toContain("fictifs");
    }
  });

  it("en production sans opérateur, coupe l'encaissement au lieu de le simuler", () => {
    const warnings: string[] = [];
    const providers = paymentProvidersFromEnv({ NODE_ENV: "production" }, (m) => warnings.push(m));
    expect(providers).toEqual({});
    expect(warnings.join("\n")).toContain("DÉGRADÉ");
  });

  it("hors production, garde le mock et avertit que le secret est absent", () => {
    const warnings: string[] = [];
    const providers = paymentProvidersFromEnv({}, (m) => warnings.push(m));
    expect(Object.keys(providers)).toEqual(["mock"]);
    expect(warnings.join("\n")).toContain("PAYMENT_WEBHOOK_SECRET");
  });

  it("hors production, avertit si le secret de démonstration est explicitement posé", () => {
    const warnings: string[] = [];
    paymentProvidersFromEnv({ PAYMENT_WEBHOOK_SECRET: "mock-secret" }, (m) => warnings.push(m));
    expect(warnings.join("\n")).toContain("mock-secret");
  });

  it("les routes se montent en production sans opérateur : l'encaissement est coupé, la facturation reste servie", () => {
    process.env.NODE_ENV = "production";
    mailConfigured();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => publicWebhookRoutes(deps)).not.toThrow();
    expect(() => invoicingRoutes(deps)).not.toThrow();
  });

  it("les routes refusent de se monter si le simulateur est explicitement réclamé", () => {
    process.env.NODE_ENV = "production";
    process.env.PAYMENT_PROVIDER = "mock";
    mailConfigured();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => publicWebhookRoutes(deps)).toThrow(/PAYMENT_PROVIDER/);
    expect(() => invoicingRoutes(deps)).toThrow(/PAYMENT_PROVIDER/);
  });
});

/** Serveur d'envoi réel : ce que la production doit avoir pour monter les routes. */
function mailConfigured(): void {
  process.env.SMTP_HOST = "smtp.exemple.test";
  process.env.MAIL_FROM_ADDRESS = "compta@exemple.test";
}

describe("canal e-mail", () => {
  it("refuse en production un expéditeur muet, en nommant les variables manquantes", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Une relance enregistrée que rien n'a envoyée est un mensonge affiché à
    // l'utilisateur : la route ne se monte pas.
    expect(() => invoicingRoutes(deps)).toThrow(/SMTP_HOST/);
    expect(() => invoicingRoutes(deps)).toThrow(/ALLOW_INSECURE_MAIL/);
  });

  it("accepte l'expéditeur muet en production si ALLOW_INSECURE_MAIL=1", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_INSECURE_MAIL = "1";
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => invoicingRoutes(deps)).not.toThrow();
  });

  it("hors production, l'expéditeur muet reste en place et s'annonce", () => {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM_ADDRESS;
    const logged: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    expect(() => invoicingRoutes({ auth: { mode: "dev" as const }, quiet: false, ledgerFor: () => ({}) } as never)).not.toThrow();
    expect(logged.join("\n")).toContain("SMTP_HOST");
  });

  it("une configuration d'envoi à moitié posée est refusée, même hors production", () => {
    process.env.SMTP_HOST = "smtp.exemple.test";
    delete process.env.MAIL_FROM_ADDRESS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => invoicingRoutes(deps)).toThrow(/MAIL_FROM_ADDRESS/);
  });
});

describe("connecteur de certification fiscale", () => {
  it("refuse CERTIFICATION_CONNECTOR=mock en production", () => {
    expect(() => certificationConnectorFromEnv({ NODE_ENV: "production", CERTIFICATION_CONNECTOR: "mock" }, () => {})).toThrow(/CERTIFICATION_CONNECTOR/);
  });

  it("accepte l'absence de connecteur en production (aucune certification inventée)", () => {
    expect(certificationConnectorFromEnv({ NODE_ENV: "production" }, () => {})).toBeInstanceOf(NullConnector);
  });

  it("hors production, garde le connecteur simulé et avertit", () => {
    const warnings: string[] = [];
    expect(certificationConnectorFromEnv({ CERTIFICATION_CONNECTOR: "mock" }, (m) => warnings.push(m))).toBeInstanceOf(MockFneConnector);
    expect(warnings.join("\n")).toMatch(/SIMULATION.*CERTIFICATION_CONNECTOR/s);
  });
});

describe("canal WhatsApp", () => {
  it("désactive le canal sans fournisseur en production", async () => {
    process.env.NODE_ENV = "production";
    process.env.WHATSAPP_APP_SECRET = "meta-app-secret";
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    resetWhatsAppProvider();
    const response = await whatsappRoutes(deps).request("/webhook");
    expect(response.status).toBe(503);
  });

  it("ignore ALLOW_INSECURE_WHATSAPP en production", async () => {
    process.env.NODE_ENV = "production";
    process.env.WHATSAPP_APP_SECRET = "meta-app-secret";
    process.env.ALLOW_INSECURE_WHATSAPP = "1";
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    resetWhatsAppProvider();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await whatsappRoutes(deps).request("/webhook");
    expect(response.status).toBe(503);
  });

  it("hors production, le mock reste en place et s'annonce", () => {
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    resetWhatsAppProvider();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => whatsappRoutes(deps)).not.toThrow();
    expect(warn.mock.calls.flat().join("\n")).toContain("WhatsApp");
  });

  it("refuse des credentials WhatsApp partiels en production", () => {
    process.env.NODE_ENV = "production";
    process.env.WHATSAPP_TOKEN = "token";
    delete process.env.WHATSAPP_PHONE_ID;
    expect(() => whatsappRoutes(deps)).toThrow(/configuration partielle/);
  });
});
