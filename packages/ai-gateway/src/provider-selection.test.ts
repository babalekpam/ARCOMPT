import { describe, expect, it, vi } from "vitest";
import { createRoutedProvider, resolveAiProviderSelection } from "./provider-selection.js";
import type { ModelRequest } from "./gateway.js";

const request = (capability: ModelRequest["capability"]): ModelRequest => ({
  capability, system: "Return JSON", input: "test", promptVersion: "test",
});

describe("explicit AI provider routing", () => {
  it("preserves only the legacy implicit local simulation, never inferring OpenAI from its key", () => {
    expect(resolveAiProviderSelection({}).simulated).toBe(true);
    expect(resolveAiProviderSelection({ OPENAI_API_KEY: "key" }).simulated).toBe(true);
    expect(resolveAiProviderSelection({ AI_PROVIDER: "openai" }).issues.join(" ")).toContain("OPENAI_API_KEY");
    expect(resolveAiProviderSelection({ AI_PROVIDER: "unknown", ANTHROPIC_API_KEY: "key" }).issues.join(" ")).toContain("AI_PROVIDER");
  });

  it("routes capture, categorization, and other tasks to exactly the configured providers", async () => {
    const selection = resolveAiProviderSelection({
      AI_PROVIDER: "openai", OPENAI_API_KEY: "openai-key",
      AI_CAPTURE_PROVIDER: "gemini", GEMINI_API_KEY: "gemini-key",
      AI_CATEGORIZE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(selection.issues).toEqual([]);
    expect(selection.selected).toEqual(["gemini", "anthropic", "openai"]);
    const complete = (name: string) => vi.fn(async () => ({ text: "{}", model: name, inputTokens: 1, outputTokens: 1 }));
    const gemini = complete("flash");
    const anthropic = complete("sonnet");
    const openai = complete("mini");
    const router = createRoutedProvider(selection, {
      gemini: { complete: gemini }, anthropic: { complete: anthropic }, openai: { complete: openai },
    });
    expect((await router.complete(request("capture"))).model).toBe("gemini/flash");
    expect((await router.complete(request("categorize"))).model).toBe("anthropic/sonnet");
    expect((await router.complete(request("assistant"))).model).toBe("openai/mini");
    expect([gemini.mock.calls.length, anthropic.mock.calls.length, openai.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it("surfaces provider errors without trying another configured model", async () => {
    const selection = resolveAiProviderSelection({
      AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key",
      AI_CAPTURE_PROVIDER: "gemini", GEMINI_API_KEY: "key",
    });
    const fallback = vi.fn(async () => ({ text: "{}", model: "sonnet", inputTokens: 1, outputTokens: 1 }));
    const router = createRoutedProvider(selection, {
      anthropic: { complete: fallback },
      gemini: { complete: async () => { throw new Error("Gemini unavailable"); } },
    });
    await expect(router.complete(request("capture"))).rejects.toThrow("Gemini unavailable");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("parses the explicit fallback provider and rejects unknown values", () => {
    expect(resolveAiProviderSelection({}).fallback).toBeNull();
    expect(resolveAiProviderSelection({ AI_FALLBACK_PROVIDER: "openai", ANTHROPIC_API_KEY: "k" }).fallback).toBe("openai");
    expect(resolveAiProviderSelection({ AI_FALLBACK_PROVIDER: "bogus", ANTHROPIC_API_KEY: "k" }).issues.join(" ")).toContain("AI_FALLBACK_PROVIDER");
  });

  it("retries once on the explicit fallback when the routed provider fails", async () => {
    const selection = resolveAiProviderSelection({
      AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key",
      AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "key",
    });
    const primary = vi.fn(async () => { throw new Error("workspace header required"); });
    const fallback = vi.fn(async () => ({ text: "{}", model: "gpt-4o-mini", inputTokens: 2, outputTokens: 3 }));
    const router = createRoutedProvider(selection, {
      anthropic: { complete: primary }, openai: { complete: fallback },
    });
    const result = await router.complete(request("assistant"));
    expect(result.model).toBe("anthropic→openai/gpt-4o-mini");
    expect([primary.mock.calls.length, fallback.mock.calls.length]).toEqual([1, 1]);
  });

  it("does not call the fallback when the routed provider succeeds", async () => {
    const selection = resolveAiProviderSelection({
      AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key",
      AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "key",
    });
    const fallback = vi.fn(async () => ({ text: "{}", model: "gpt-4o-mini", inputTokens: 1, outputTokens: 1 }));
    const router = createRoutedProvider(selection, {
      anthropic: { complete: async () => ({ text: "{}", model: "sonnet", inputTokens: 1, outputTokens: 1 }) },
      openai: { complete: fallback },
    });
    expect((await router.complete(request("assistant"))).model).toBe("anthropic/sonnet");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("surfaces a combined error when the fallback also fails", async () => {
    const selection = resolveAiProviderSelection({
      AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key",
      AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "key",
    });
    const router = createRoutedProvider(selection, {
      anthropic: { complete: async () => { throw new Error("primary down"); } },
      openai: { complete: async () => { throw new Error("fallback down"); } },
    });
    await expect(router.complete(request("assistant"))).rejects.toThrow(/primary down.*fallback down/);
  });
});