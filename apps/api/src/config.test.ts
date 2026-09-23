// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { ConfigError, INSECURE_OPT_OUT, isOptOutEnabled, loadConfig } from "./config.js";

/**
 * Validation de la configuration au démarrage : une production ne doit jamais
 * tourner sur un simulateur, et doit apprendre TOUS ses problèmes d'un coup.
 */

const PAYROLL_KEY = Buffer.alloc(32, 7).toString("base64");

/** Environnement de production complet et conforme. */
function productionEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:pass@db.internal:5432/arcompt",
    AUTH_MODE: "oidc",
    KEYCLOAK_ISSUER: "https://auth.arcompt.africa/realms/arcompt",
    KEYCLOAK_CLIENT_ID: "arcompt-api",
    PAYMENT_PROVIDER: "wave",
    PAYMENT_WEBHOOK_SECRET: "x".repeat(48),
    PAYROLL_ENCRYPTION_KEY: PAYROLL_KEY,
    ANTHROPIC_API_KEY: "sk-ant-reel",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "arcompt-prod",
    CLAMAV_HOST: "clamd.internal",
    CERTIFICATION_CONNECTOR: "fne",
    WHATSAPP_TOKEN: "meta-token",
    WHATSAPP_PHONE_ID: "123456",
    WHATSAPP_APP_SECRET: "meta-app-secret",
    ...over,
  };
}

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env, { warn: () => {} });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return [...(e as ConfigError).problems];
  }
  throw new Error("loadConfig aurait dû lever");
}

describe("loadConfig — production conforme", () => {
  it("accepte Clerk uniquement avec secret et parties autorisées non vides", () => {
    const cfg = loadConfig(productionEnv({
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_AUTHORIZED_PARTIES: "https://app.example, https://www.example",
      APP_URL: "",
      KEYCLOAK_ISSUER: "",
      KEYCLOAK_CLIENT_ID: "",
    }), { warn: () => {} });
    expect(cfg.auth).toEqual({
      mode: "clerk",
      secretKey: "sk_test_example",
      authorizedParties: ["https://app.example", "https://www.example"],
    });
  });

  it("refuse Clerk en production sans partie autorisée", () => {
    const problems = problemsOf(productionEnv({
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_AUTHORIZED_PARTIES: "",
      APP_URL: "",
      KEYCLOAK_ISSUER: "",
      KEYCLOAK_CLIENT_ID: "",
    }));
    expect(problems.join("\n")).toContain("CLERK_AUTHORIZED_PARTIES");
  });

  it("accepte un environnement de production complet et renvoie les valeurs typées", () => {
    const cfg = loadConfig(productionEnv({ API_PORT: "8080", DEFAULT_CURRENCY: "XAF" }), { warn: () => {} });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.problems).toEqual([]);
    expect(cfg.port).toBe(8080);
    expect(cfg.baseCurrency).toBe("XAF");
    expect(cfg.databaseUrl).toBe("postgres://user:pass@db.internal:5432/arcompt");
    expect(cfg.auth).toEqual({ mode: "oidc", issuer: "https://auth.arcompt.africa/realms/arcompt", audience: "arcompt-api" });
    expect(cfg.storage.driver).toBe("r2");
    expect(cfg.antivirus.driver).toBe("clamav");
    expect(cfg.ai.simulated).toBe(false);
    expect(cfg.whatsapp.simulated).toBe(false);
    expect(cfg.payments.simulated).toBe(false);
    expect(cfg.certification.simulated).toBe(false);
  });

  it("accepte les simulations seulement si l'opt-out ALLOW_INSECURE_* est posé", () => {
    const env = productionEnv({
      ANTHROPIC_API_KEY: "",
      R2_ACCOUNT_ID: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET: "",
      CLAMAV_HOST: "",
      WHATSAPP_TOKEN: "",
      WHATSAPP_PHONE_ID: "",
    });
    expect(() => loadConfig(env, { warn: () => {} })).toThrow(ConfigError);

    const cfg = loadConfig(
      {
        ...env,
        [INSECURE_OPT_OUT.ai]: "1",
        [INSECURE_OPT_OUT.storage]: "true",
        [INSECURE_OPT_OUT.antivirus]: "yes",
        [INSECURE_OPT_OUT.whatsapp]: "1",
      },
      { warn: () => {} },
    );
    expect(cfg.problems).toEqual([]);
    // L'opt-out des packs non publiés reste fermé : il n'est pas posé ici.
    expect(cfg.insecure).toEqual({ ai: true, storage: true, antivirus: true, whatsapp: true, draftPackFilings: false });
    expect(cfg.ai.simulated).toBe(true);
    expect(cfg.storage.driver).toBe("local");
    expect(cfg.antivirus.driver).toBe("none");
    expect(cfg.degraded.join(" ")).not.toContain(INSECURE_OPT_OUT.draftPackFilings);
  });

  it("le pack non publié : l'opt-out ne bloque pas le démarrage mais est annoncé comme dégradé", () => {
    const base = productionEnv({
      [INSECURE_OPT_OUT.ai]: "1",
      [INSECURE_OPT_OUT.storage]: "1",
      [INSECURE_OPT_OUT.antivirus]: "1",
      [INSECURE_OPT_OUT.whatsapp]: "1",
    });
    const off = loadConfig(base, { warn: () => {} });
    expect(off.insecure.draftPackFilings).toBe(false);

    const on = loadConfig({ ...base, [INSECURE_OPT_OUT.draftPackFilings]: "1" }, { warn: () => {} });
    expect(on.insecure.draftPackFilings).toBe(true);
    expect(on.problems).toEqual([]);
    const notice = on.degraded.find((d) => d.includes(INSECURE_OPT_OUT.draftPackFilings));
    expect(notice).toBeDefined();
    expect(notice).toContain("DOCUMENT NON OFFICIEL");
  });

  it("n'accepte pas n'importe quelle valeur comme opt-out", () => {
    expect(isOptOutEnabled("1")).toBe(true);
    expect(isOptOutEnabled("TRUE")).toBe(true);
    expect(isOptOutEnabled("yes")).toBe(true);
    expect(isOptOutEnabled("0")).toBe(false);
    expect(isOptOutEnabled("")).toBe(false);
    expect(isOptOutEnabled(undefined)).toBe(false);
    expect(isOptOutEnabled("peut-être")).toBe(false);
  });
});

describe("loadConfig — production incomplète", () => {
  it("rassemble TOUS les problèmes en une seule erreur, pas seulement le premier", () => {
    const problems = problemsOf({ NODE_ENV: "production", AUTH_MODE: "dev", CERTIFICATION_CONNECTOR: "mock", PAYMENT_PROVIDER: "mock" });
    const expected = [
      "DATABASE_URL",
      "AUTH_MODE",
      "KEYCLOAK_ISSUER",
      "KEYCLOAK_CLIENT_ID",
      "PAYMENT_WEBHOOK_SECRET",
      "PAYMENT_PROVIDER",
      "CERTIFICATION_CONNECTOR",
      "PAYROLL_ENCRYPTION_KEY",
      "ANTHROPIC_API_KEY",
      "R2_ACCOUNT_ID",
      "CLAMAV_HOST",
      "WHATSAPP_TOKEN",
    ];
    for (const variable of expected) {
      expect(problems.some((p) => p.includes(variable)), `${variable} devrait être signalé`).toBe(true);
    }
    expect(problems.length).toBeGreaterThanOrEqual(expected.length);
  });

  it("le message de l'erreur cite chaque variable manquante", () => {
    let message = "";
    try {
      loadConfig({ NODE_ENV: "production", PAYMENT_PROVIDER: "wave" }, { warn: () => {} });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const variable of ["DATABASE_URL", "AUTH_MODE", "PAYMENT_WEBHOOK_SECRET", "PAYROLL_ENCRYPTION_KEY", "ANTHROPIC_API_KEY", "CLAMAV_HOST"]) {
      expect(message).toContain(variable);
    }
  });

  it("refuse le secret de webhook de démonstration et les secrets trop courts", () => {
    expect(problemsOf(productionEnv({ PAYMENT_WEBHOOK_SECRET: "mock-secret" })).join("\n")).toContain("mock-secret");
    expect(problemsOf(productionEnv({ PAYMENT_WEBHOOK_SECRET: "trop-court" })).join("\n")).toMatch(/PAYMENT_WEBHOOK_SECRET.*trop court/s);
  });

  it("refuse un mode d'authentification « dev »", () => {
    expect(problemsOf(productionEnv({ AUTH_MODE: "dev" })).join("\n")).toContain("AUTH_MODE");
  });

  it("refuse le connecteur de certification simulé, sans opt-out possible", () => {
    const problems = problemsOf(productionEnv({ CERTIFICATION_CONNECTOR: "mock", ALLOW_INSECURE_CERTIFICATION: "1" }));
    expect(problems.join("\n")).toContain("CERTIFICATION_CONNECTOR");
  });

  it("refuse l'opérateur de paiement simulé, sans opt-out possible", () => {
    expect(problemsOf(productionEnv({ PAYMENT_PROVIDER: "mock", ALLOW_INSECURE_PAYMENTS: "1" })).join("\n")).toContain("PAYMENT_PROVIDER");
  });

  it("n'exige le secret WhatsApp que si le canal est réellement configuré", () => {
    // Exiger ce secret d'un déploiement sans WhatsApp empêchait de démarrer
    // sans bénéfice, et poussait à inventer une valeur.
    const sansCanal = loadConfig(productionEnv({ WHATSAPP_TOKEN: "", WHATSAPP_PHONE_ID: "", WHATSAPP_APP_SECRET: "", ALLOW_INSECURE_WHATSAPP: "1" }), { warn: () => {} });
    expect(sansCanal.degraded.join("\n")).toContain("WhatsApp");

    const avecCanal = problemsOf(productionEnv({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "p", WHATSAPP_APP_SECRET: "" }));
    expect(avecCanal.join("\n")).toContain("WHATSAPP_APP_SECRET");
  });

  it("sans opérateur de paiement, démarre en mode dégradé plutôt que d'échouer", () => {
    // Aucun opérateur réel n'existe encore : couper l'encaissement est
    // acceptable, couper toute la plateforme comptable ne l'est pas.
    const cfg = loadConfig(productionEnv({ PAYMENT_PROVIDER: "", PAYMENT_WEBHOOK_SECRET: "" }), { warn: () => {} });
    expect(cfg.payments.enabled).toBe(false);
    expect(cfg.degraded.join("\n")).toContain("PAYMENT_PROVIDER");
  });

  it("exige une clé de paie base64 de 32 octets", () => {
    expect(problemsOf(productionEnv({ PAYROLL_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).join("\n")).toContain("PAYROLL_ENCRYPTION_KEY");
    expect(problemsOf(productionEnv({ PAYROLL_ENCRYPTION_KEY: "pas du base64 !" })).join("\n")).toContain("PAYROLL_ENCRYPTION_KEY");
  });

  it("exige les quatre variables R2 et pas seulement une", () => {
    expect(problemsOf(productionEnv({ R2_BUCKET: "" })).join("\n")).toContain("R2_BUCKET");
  });
});

describe("loadConfig — développement permissif", () => {
  it("ne lève pas et signale les simulations en avertissement", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ AUTH_MODE: "dev", DATABASE_URL: "postgres://localhost/arcompt" }, { warn: (m) => warnings.push(m) });
    expect(cfg.isProduction).toBe(false);
    expect(cfg.auth.mode).toBe("dev");
    expect(cfg.ai.simulated).toBe(true);
    expect(cfg.storage.driver).toBe("local");
    expect(cfg.antivirus.driver).toBe("none");
    expect(cfg.payments.simulated).toBe(true);
    expect(cfg.problems.length).toBeGreaterThan(0);
    expect(warnings.length).toBe(cfg.problems.length);
  });

  it("applique les valeurs par défaut locales", () => {
    const cfg = loadConfig({}, { warn: () => {} });
    expect(cfg.port).toBe(4000);
    expect(cfg.baseCurrency).toBe("XOF");
    expect(cfg.nodeEnv).toBe("development");
    expect(cfg.databaseUrl).toBeUndefined();
  });

  it("l'environnement de la CI (AUTH_MODE=dev, sans NODE_ENV=production) reste accepté", () => {
    expect(() => loadConfig({ AUTH_MODE: "dev", NODE_ENV: "test" }, { warn: () => {} })).not.toThrow();
  });
});
