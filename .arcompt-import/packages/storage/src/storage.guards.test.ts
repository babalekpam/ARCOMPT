// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { LocalStorage } from "./local.js";
import { R2Storage } from "./r2.js";
import { StorageError } from "./storage.js";
import { createStorageFromEnv } from "./index.js";

/**
 * Garde-fou : les pièces sont conservées dix ans (AUDCIF). En production, le
 * repli vers le disque local éphémère du conteneur est refusé.
 */

const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "arcompt" };

describe("createStorageFromEnv", () => {
  it("choisit R2 dès que les variables R2_* sont présentes", () => {
    expect(createStorageFromEnv({ NODE_ENV: "production", ...R2_ENV })).toBeInstanceOf(R2Storage);
  });

  it("refuse le stockage local en production et nomme les variables manquantes", () => {
    expect(() => createStorageFromEnv({ NODE_ENV: "production" })).toThrow(StorageError);
    try {
      createStorageFromEnv({ NODE_ENV: "production" });
    } catch (e) {
      expect((e as Error).message).toContain("R2_BUCKET");
      expect((e as Error).message).toContain("ALLOW_INSECURE_STORAGE");
      expect((e as Error).message).toMatch(/éphémère/);
    }
  });

  it("accepte le stockage local en production si ALLOW_INSECURE_STORAGE=1", () => {
    const messages: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void messages.push(String(m));
    try {
      expect(createStorageFromEnv({ NODE_ENV: "production", ALLOW_INSECURE_STORAGE: "1", STORAGE_DIR: "./.data/test-storage" })).toBeInstanceOf(LocalStorage);
    } finally {
      console.warn = original;
    }
    expect(messages.join("\n")).toContain("SIMULATION");
  });

  it("hors production, le stockage local reste le repli et avertit", () => {
    const messages: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void messages.push(String(m));
    try {
      expect(createStorageFromEnv({ STORAGE_DIR: "./.data/test-storage" })).toBeInstanceOf(LocalStorage);
    } finally {
      console.warn = original;
    }
    expect(messages.join("\n")).toContain("R2_BUCKET");
  });
});
