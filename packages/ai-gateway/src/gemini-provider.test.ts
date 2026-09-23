import { describe, expect, it, vi } from "vitest";
import { GeminiProvider, GeminiProviderError } from "./gemini-provider.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json" } });
}

describe("GeminiProvider", () => {
  it("sends JSON mode, system instructions, inline images, and returns usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      modelVersion: "gemini-2.5-flash-001",
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
    }));
    const provider = new GeminiProvider({ apiKey: "secret", fetchImpl });
    const result = await provider.complete({
      capability: "capture", promptVersion: "1", system: "Extract fields", input: { a: 1 },
      images: [{ mediaType: "image/png", data: "aGVsbG8=" }], maxTokens: 100,
    });
    expect(result).toEqual({ text: '{"ok":true}', model: "gemini-2.5-flash-001", inputTokens: 12, outputTokens: 4 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret");
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json", maxOutputTokens: 100 });
    expect(body.contents[0].parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
  });

  it("fails explicitly for blocked and malformed output", async () => {
    const blocked = new GeminiProvider({ apiKey: "key", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ promptFeedback: { blockReason: "SAFETY" } })) });
    await expect(blocked.complete({ capability: "assistant", promptVersion: "1", system: "", input: "x" })).rejects.toThrow(/blocked/);
    const malformed = new GeminiProvider({ apiKey: "key", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ candidates: [{ content: { parts: [] } }] })) });
    await expect(malformed.complete({ capability: "assistant", promptVersion: "1", system: "", input: "x" })).rejects.toBeInstanceOf(GeminiProviderError);
  });

  it("rejects a response without auditable token usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }],
    }));
    await expect(new GeminiProvider({ apiKey: "key", fetchImpl }).complete({
      capability: "capture", promptVersion: "1", system: "x", input: "x",
    })).rejects.toThrow(/token usage/);
  });

  it("bounds and sanitizes API errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`failure key ${"x".repeat(3000)}`, { status: 400 }));
    await expect(new GeminiProvider({ apiKey: "key", fetchImpl }).complete({ capability: "assistant", promptVersion: "1", system: "", input: "x" }))
      .rejects.toThrow(/failure/);
    try {
      await new GeminiProvider({ apiKey: "key", fetchImpl }).complete({ capability: "assistant", promptVersion: "1", system: "", input: "x" });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThanOrEqual(1024);
      expect((error as Error).message).not.toContain("key");
    }
  });
});