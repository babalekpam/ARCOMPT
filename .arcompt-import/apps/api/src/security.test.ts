// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { redactSecrets, TokenBucketLimiter } from "./security.js";
import { BurstDetector } from "./telemetry.js";

describe("sécurité API", () => {
  it("limite le débit par seau de jetons et se recharge avec le temps", () => {
    let now = 0;
    const l = new TokenBucketLimiter({ limit: 3, windowMs: 3000 }, () => now);
    expect(l.take("a")).toBe(2);
    expect(l.take("a")).toBe(1);
    expect(l.take("a")).toBe(0);
    expect(l.take("a")).toBe(-1);
    expect(l.take("b")).toBe(2); // clé indépendante
    now = 1000; // +1 jeton
    expect(l.take("a")).toBe(0);
  });

  it("détecte une rafale d'échecs", () => {
    const d = new BurstDetector(3, 1000);
    expect(d.hit("ip", 0)).toBe(false);
    expect(d.hit("ip", 100)).toBe(false);
    expect(d.hit("ip", 200)).toBe(true);
    expect(d.hit("ip", 5000)).toBe(false);
  });

  it("masque les secrets dans les journaux", () => {
    const line = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 key=sk-ant-abcdefghijklmnopqrstuvwxyz password=hunter2&x card 4111111111111111";
    const out = redactSecrets(line);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("4111111111111111");
    expect(out).not.toMatch(/Bearer abcdef/);
  });
});
