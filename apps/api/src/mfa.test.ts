import { afterEach, describe, expect, it, vi } from "vitest";
import { base32, decryptMfa, encryptMfa, matchingStep, totp } from "./mfa.js";

afterEach(() => vi.unstubAllEnvs());
describe("authenticator cryptography", () => {
  it("preserves key bytes for legacy base64 representations", () => {
    const canonical = Buffer.alloc(32, 7).toString("base64");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const alternatePadBits = canonical.slice(0, -2) +
      alphabet[alphabet.indexOf(canonical.at(-2)!) + 1] + "=";
    vi.stubEnv("PAYROLL_ENCRYPTION_KEY", canonical);
    const secret = Buffer.alloc(20, 3);
    const ciphertext = encryptMfa(secret, "user_a");
    for (const encoded of [canonical.replace(/=+$/, ""), ` ${canonical}\n`, alternatePadBits]) {
      vi.stubEnv("PAYROLL_ENCRYPTION_KEY", encoded);
      expect(decryptMfa(ciphertext, "user_a")).toEqual(secret);
      const encrypted = encryptMfa(secret, "user_a");
      vi.stubEnv("PAYROLL_ENCRYPTION_KEY", canonical);
      expect(decryptMfa(encrypted, "user_a")).toEqual(secret);
    }
  });
  it("rejects missing or wrong-length master keys without a development fallback", () => {
    for (const encoded of ["", "invalid", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")]) {
      vi.stubEnv("PAYROLL_ENCRYPTION_KEY", encoded);
      expect(() => encryptMfa(Buffer.alloc(20), "user_a")).toThrow("MFA_KEY_UNAVAILABLE");
    }
  });
  it("matches RFC4226/RFC6238 SHA1 vectors truncated to six digits", () => {
    const secret = Buffer.from("12345678901234567890");
    expect(base32(secret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    for (const [time, expected] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]] as const) {
      expect(totp(secret, Math.floor(time / 30))).toBe(expected);
      expect(matchingStep(secret, expected, time * 1000)).toBe(Math.floor(time / 30));
    }
    expect(matchingStep(secret, "abcdef")).toBeNull();
    expect(matchingStep(secret, totp(secret, 1), 180000)).toBeNull();
  });
  it("uses random IVs and subject-bound authenticated encryption with no fallback", () => {
    vi.stubEnv("PAYROLL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const secret = Buffer.alloc(20, 3);
    const ciphertext = encryptMfa(secret, "user_a");
    expect(encryptMfa(secret, "user_a")).not.toBe(ciphertext);
    expect(decryptMfa(ciphertext, "user_a")).toEqual(secret);
    expect(() => decryptMfa(ciphertext, "user_b")).toThrow();
    vi.stubEnv("PAYROLL_ENCRYPTION_KEY", "");
    expect(() => encryptMfa(secret, "user_a")).toThrow("MFA_KEY_UNAVAILABLE");
  });
});