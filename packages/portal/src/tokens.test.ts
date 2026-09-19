import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken, tokenHashEquals } from "./tokens.js";

describe("jetons d'invitation", () => {
  it("génère des jetons aléatoires base64url de 256 bits", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hash SHA-256 hexadécimal, déterministe, sans révéler le jeton", () => {
    const token = "jeton-de-test";
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).not.toContain(token);
    expect(hashInvitationToken(token + "x")).not.toBe(hash);
  });

  it("compare les hashs en temps constant", () => {
    const h = hashInvitationToken("a");
    expect(tokenHashEquals(h, h)).toBe(true);
    expect(tokenHashEquals(h, hashInvitationToken("b"))).toBe(false);
    expect(tokenHashEquals(h, "")).toBe(false);
  });
});
