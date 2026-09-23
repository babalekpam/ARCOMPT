// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageFromEnv, LocalStorage, sanitizeKey, StorageError } from "./index.js";

let dir: string;
let storage: LocalStorage;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcompt-storage-"));
  storage = new LocalStorage(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalStorage", () => {
  it("écrit, relit, teste l'existence et supprime un objet", async () => {
    const key = "tenant-a/2025/facture.pdf";
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.get(key)).toBeNull();
    await storage.put(key, new TextEncoder().encode("%PDF-1.4 test"), { contentType: "application/pdf" });
    expect(await storage.exists(key)).toBe(true);
    const got = await storage.get(key);
    expect(got?.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(got!.bytes)).toBe("%PDF-1.4 test");
    expect(await storage.signedUrl(key, 60)).toMatch(/^file:\/\/.*facture\.pdf$/);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.signedUrl(key, 60)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("assainit les clés et refuse toute sortie du répertoire", () => {
    expect(sanitizeKey("a/b/Facture CIE (1).pdf")).toBe("a/b/Facture_CIE__1_.pdf");
    expect(sanitizeKey("a//b\\c")).toBe("a/b/c");
    expect(() => sanitizeKey("../etc/passwd")).toThrow(StorageError);
    expect(() => sanitizeKey("a/../../x")).toThrow(StorageError);
    expect(() => sanitizeKey("/abs")).toThrow(StorageError);
    expect(() => sanitizeKey("")).toThrow(StorageError);
    expect(() => sanitizeKey("a/...")).toThrow(StorageError);
  });

  it("createStorageFromEnv retombe sur le local sans variables R2", () => {
    const s = createStorageFromEnv({ STORAGE_DIR: dir });
    expect(s).toBeInstanceOf(LocalStorage);
    expect(() => createStorageFromEnv({ R2_ACCOUNT_ID: "x" })).toThrow(/R2/);
  });
});
