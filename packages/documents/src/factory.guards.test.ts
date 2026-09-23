// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createDocumentsInfraFromEnv, resetDocumentsInfra } from "./factory.js";
import { ClamAvScanner, NoopScanner, createScannerFromEnv } from "./security.js";

/**
 * Garde-fous : en production, ni l'extraction IA simulée ni l'antivirus neutre
 * ne peuvent être choisis silencieusement. Hors production, rien ne change.
 */

const db = {} as Sql;

afterEach(() => resetDocumentsInfra());

describe("passerelle IA", () => {
  it("refuse le fournisseur hors ligne en production et nomme ANTHROPIC_API_KEY", () => {
    expect(() => createDocumentsInfraFromEnv(db, { NODE_ENV: "production" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("dit dans l'erreur ce qui serait simulé et comment l'accepter sciemment", () => {
    try {
      createDocumentsInfraFromEnv(db, { NODE_ENV: "production" });
    } catch (e) {
      expect((e as Error).message).toMatch(/extraction/i);
      expect((e as Error).message).toContain("ALLOW_INSECURE_AI");
    }
  });

  it("accepte le fournisseur hors ligne en production si ALLOW_INSECURE_AI=1", () => {
    const infra = createDocumentsInfraFromEnv(db, { NODE_ENV: "production", ALLOW_INSECURE_AI: "1", CLAMAV_HOST: "clamd", R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b", R2_SECRET_ACCESS_KEY: "c", R2_BUCKET: "d" });
    expect(infra.gateway).toBeDefined();
  });

  it("hors production, le fournisseur hors ligne reste disponible", () => {
    expect(() => createDocumentsInfraFromEnv(db, {})).not.toThrow();
  });

  it("n'active jamais un fournisseur explicitement sélectionné sans sa propre clé", () => {
    expect(() => createDocumentsInfraFromEnv(db, { AI_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => createDocumentsInfraFromEnv(db, { AI_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => createDocumentsInfraFromEnv(db, { AI_PROVIDER: "autre", ANTHROPIC_API_KEY: "key" })).toThrow(/AI_PROVIDER/);
  });

  it("accepte OpenAI et Gemini sans exiger de clé Anthropic inutilisée", () => {
    expect(() => createDocumentsInfraFromEnv(db, { AI_PROVIDER: "openai", OPENAI_API_KEY: "test-key" })).not.toThrow();
    resetDocumentsInfra();
    expect(() => createDocumentsInfraFromEnv(db, { AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" })).not.toThrow();
  });
});

describe("antivirus", () => {
  it("utilise ClamAV dès que CLAMAV_HOST est présent", () => {
    expect(createScannerFromEnv({ CLAMAV_HOST: "clamd.internal" })).toBeInstanceOf(ClamAvScanner);
  });

  it("refuse le scanner neutre en production et nomme CLAMAV_HOST", () => {
    expect(() => createScannerFromEnv({ NODE_ENV: "production" })).toThrow(/CLAMAV_HOST/);
    expect(() => createScannerFromEnv({ NODE_ENV: "production" })).toThrow(/ALLOW_INSECURE_ANTIVIRUS/);
  });

  it("accepte le scanner neutre en production si ALLOW_INSECURE_ANTIVIRUS=1", () => {
    expect(createScannerFromEnv({ NODE_ENV: "production", ALLOW_INSECURE_ANTIVIRUS: "1" })).toBeInstanceOf(NoopScanner);
  });

  it("hors production, le scanner neutre reste en place", () => {
    expect(createScannerFromEnv({ CLAMAV_HOST: "" })).toBeInstanceOf(NoopScanner);
  });
});

describe("avertissements hors production", () => {
  it("nomme ce qui est simulé", () => {
    const messages: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void messages.push(String(m));
    try {
      createDocumentsInfraFromEnv(db, {});
    } finally {
      console.warn = original;
    }
    const joined = messages.join("\n");
    expect(joined).toContain("ANTHROPIC_API_KEY");
    expect(joined).toContain("CLAMAV_HOST");
  });
});
