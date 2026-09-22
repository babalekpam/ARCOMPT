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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => publicWebhookRoutes(deps)).not.toThrow();
    expect(() => invoicingRoutes(deps)).not.toThrow();
  });

  it("les routes refusent de se monter si le simulateur est explicitement réclamé", () => {
    process.env.NODE_ENV = "production";
    process.env.PAYMENT_PROVIDER = "mock";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => publicWebhookRoutes(deps)).toThrow(/PAYMENT_PROVIDER/);
    expect(() => invoicingRoutes(deps)).toThrow(/PAYMENT_PROVIDER/);
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
  it("refuse le fournisseur mock en production, en nommant les variables manquantes", () => {
    process.env.NODE_ENV = "production";
    process.env.WHATSAPP_APP_SECRET = "meta-app-secret";
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    resetWhatsAppProvider();
    expect(() => whatsappRoutes(deps)).toThrow(/WHATSAPP_TOKEN/);
  });

  it("accepte le mock en production si ALLOW_INSECURE_WHATSAPP=1", () => {
    process.env.NODE_ENV = "production";
    process.env.WHATSAPP_APP_SECRET = "meta-app-secret";
    process.env.ALLOW_INSECURE_WHATSAPP = "1";
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    resetWhatsAppProvider();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => whatsappRoutes(deps)).not.toThrow();
  });

  it("hors production, le mock reste en place", () => {
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    resetWhatsAppProvider();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => whatsappRoutes(deps)).not.toThrow();
    expect(warn.mock.calls.flat().join("\n")).toContain("WHATSAPP_TOKEN");
  });
});
