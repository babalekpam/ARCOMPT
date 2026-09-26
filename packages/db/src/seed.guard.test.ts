import { describe, expect, it } from "vitest";
import { assertDemoSeedAllowed, seedDemo, seedFirmDemo } from "./seed.js";

describe("demo fixture opt-in", () => {
  it.each(["production", undefined, "staging", "development", "test"])("fails closed for %s without consent", async (environment) => {
    const env = { NODE_ENV: environment, ALLOW_DEMO_SEED: undefined };
    expect(() => assertDemoSeedAllowed(env)).toThrow(/ALLOW_DEMO_SEED/);
  });

  it("rejects production even with consent, and permits only explicit local consent", () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: "1" })).toThrow(/NODE_ENV/);
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "development", ALLOW_DEMO_SEED: "true" })).toThrow(/ALLOW_DEMO_SEED/);
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "development", ALLOW_DEMO_SEED: "1" })).not.toThrow();
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "test", ALLOW_DEMO_SEED: "1" })).not.toThrow();
  });

  it("guards both exported helpers before touching the database", async () => {
    const previous = process.env.ALLOW_DEMO_SEED;
    delete process.env.ALLOW_DEMO_SEED;
    try {
      const unusedDb = (() => { throw new Error("Database touched"); }) as never;
      await expect(seedDemo(unusedDb)).rejects.toThrow(/ALLOW_DEMO_SEED/);
      await expect(seedFirmDemo(unusedDb)).rejects.toThrow(/ALLOW_DEMO_SEED/);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_DEMO_SEED;
      else process.env.ALLOW_DEMO_SEED = previous;
    }
  });
});