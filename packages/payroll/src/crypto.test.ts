// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvKeyProvider, maskSensitive, PayrollCrypto, PayrollCryptoError, resolveMasterKey, TenantCipher, type KeyProvider } from "./crypto.js";

const master = randomBytes(32);

describe("chiffrement par enveloppe", () => {
  it("aller-retour : clé de données enveloppée, champ chiffré et déchiffré", async () => {
    const crypto = new PayrollCrypto(new EnvKeyProvider({ key: master }));
    const { record, key } = await crypto.generateTenantKey(1);
    expect(record).toMatchObject({ version: 1, status: "ACTIVE", masterKeyId: crypto.masterKeyId });
    expect(record.wrappedKey).toMatch(/^env:v1:/);
    expect(record.wrappedKey).not.toContain(key.toString("base64"));
    const cipher = await crypto.cipherFor([record]);
    const stored = cipher.encrypt("500000.0000");
    expect(stored).toMatch(/^v2:1:/);
    expect(stored).not.toContain("500000");
    expect(cipher.decrypt(stored)).toBe("500000.0000");
    expect(cipher.encrypt("x")).not.toBe(cipher.encrypt("x")); // IV aléatoire
    expect(cipher.decryptJson(cipher.encryptJson({ iban: "CI93 0001" }))).toEqual({ iban: "CI93 0001" });
    expect(TenantCipher.versionOf(stored)).toBe(1);
  });

  it("détecte toute altération, une mauvaise clé maître ou une version de clé inconnue", async () => {
    const crypto = new PayrollCrypto(new EnvKeyProvider({ key: master }));
    const { record } = await crypto.generateTenantKey(1);
    const cipher = await crypto.cipherFor([record]);
    const stored = cipher.encrypt("secret");
    const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => cipher.decrypt(tampered)).toThrow(PayrollCryptoError);
    expect(() => cipher.decrypt(stored.replace(/^v2:1:/, "v2:2:"))).toThrowError(/version de clé 2/);
    expect(() => cipher.decrypt("v1:abc")).toThrowError(/format inconnu/);
    const other = new PayrollCrypto(new EnvKeyProvider({ key: randomBytes(32) }));
    await expect(other.cipherFor([record])).rejects.toThrowError(/autre clé maître/);
    await expect(other.cipherFor([{ ...record, masterKeyId: other.masterKeyId }])).rejects.toThrowError(/authentification/);
  });

  it("lit les anciennes versions après rotation et chiffre avec la version active", async () => {
    const crypto = new PayrollCrypto(new EnvKeyProvider({ key: master }));
    const v1 = await crypto.generateTenantKey(1);
    const c1 = await crypto.cipherFor([v1.record]);
    const old = c1.encrypt("ancien");
    const v2 = await crypto.generateTenantKey(2);
    const c2 = await crypto.cipherFor([{ ...v1.record, status: "RETIRED" }, v2.record]);
    expect(c2.activeVersion).toBe(2);
    expect(c2.versions()).toEqual([1, 2]);
    expect(c2.decrypt(old)).toBe("ancien");
    expect(c2.encrypt("nouveau")).toMatch(/^v2:2:/);
    await expect(crypto.cipherFor([{ ...v1.record, status: "RETIRED" }])).rejects.toThrowError(/active/);
  });

  it("un KeyProvider externe (KMS) remplace la clé d'environnement", async () => {
    const calls: string[] = [];
    const kms: KeyProvider = {
      id: "kms:test",
      async wrap(k) {
        calls.push("wrap");
        return `kms:${k.toString("base64")}`;
      },
      async unwrap(w, id) {
        calls.push(`unwrap:${id}`);
        return Buffer.from(w.slice(4), "base64");
      },
    };
    const crypto = new PayrollCrypto(kms);
    const { record } = await crypto.generateTenantKey(1);
    expect(record.masterKeyId).toBe("kms:test");
    const cipher = await crypto.cipherFor([record]);
    expect(cipher.decrypt(cipher.encrypt("ok"))).toBe("ok");
    expect(calls).toEqual(["wrap", "unwrap:kms:test"]);
  });
});

describe("clé maître", () => {
  it("lit PAYROLL_ENCRYPTION_KEY en base64 (32 octets) et refuse une longueur incorrecte", () => {
    const key = resolveMasterKey({ env: { PAYROLL_ENCRYPTION_KEY: master.toString("base64") } });
    expect(key.equals(master)).toBe(true);
    expect(() => resolveMasterKey({ env: { PAYROLL_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") } })).toThrowError(/32 octets/);
    expect(() => resolveMasterKey({ key: Buffer.alloc(8) })).toThrowError(/32 octets/);
  });

  it("hors production, retombe sur une clé déterministe avec avertissement ; en production, échoue", () => {
    const warnings: string[] = [];
    const a = resolveMasterKey({ env: { NODE_ENV: "test" }, warn: (m) => warnings.push(m) });
    const b = resolveMasterKey({ env: { NODE_ENV: "development" }, warn: (m) => warnings.push(m) });
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(warnings.length).toBeLessThanOrEqual(1); // avertissement émis une seule fois par processus
    expect(() => resolveMasterKey({ env: { NODE_ENV: "production" } })).toThrowError(/obligatoire en production/);
  });

  it("l'identifiant du fournisseur dérive de la clé sans la révéler", () => {
    const p1 = new EnvKeyProvider({ key: master });
    const p2 = new EnvKeyProvider({ key: master });
    const p3 = new EnvKeyProvider({ key: randomBytes(32) });
    expect(p1.id).toBe(p2.id);
    expect(p1.id).not.toBe(p3.id);
    expect(p1.id).toMatch(/^env:[0-9a-f]{16}$/);
    expect(master.toString("hex")).not.toContain(p1.id.slice(4));
  });
});

describe("maskSensitive", () => {
  it("ne garde que la fin de la valeur", () => {
    expect(maskSensitive("CI9300012345678", 4)).toBe("********5678");
    expect(maskSensitive("ab", 4)).toBe("**");
    expect(maskSensitive(null)).toBeNull();
  });
});
