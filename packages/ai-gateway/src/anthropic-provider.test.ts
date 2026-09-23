import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json" } });
}

const request = { capability: "capture" as const, promptVersion: "1", system: "Extract fields", input: { a: 1 } };

describe("AnthropicProvider", () => {
  it("sends native image content and returns usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      model: "claude-sonnet-5", content: [{ type: "text", text: '{"ok":true}' }],
      stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 7 },
    }));
    const result = await new AnthropicProvider({ apiKey: "server-key", fetchImpl }).complete({
      ...request, images: [{ mediaType: "image/png", data: "YWJj" }],
    });
    expect(result).toEqual({ text: '{"ok":true}', model: "claude-sonnet-5", inputTokens: 12, outputTokens: 7 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("server-key");
    expect(JSON.parse(String(init?.body)).messages[0].content[0]).toEqual({
      type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" },
    });
  });

  it("rejects missing keys, malformed output, and incomplete responses", async () => {
    expect(() => new AnthropicProvider({ apiKey: "  " })).toThrow(/API key/);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      model: "claude-sonnet-5", content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await expect(new AnthropicProvider({ apiKey: "key", fetchImpl }).complete(request)).rejects.toThrow(/incomplete/);
    fetchImpl.mockResolvedValue(response({ model: "x", content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    await expect(new AnthropicProvider({ apiKey: "key", fetchImpl }).complete(request)).rejects.toThrow(/no text/);
  });

  it("aborts timed out requests and bounds sanitized API errors", async () => {
    const timeoutFetch = vi.fn<typeof fetch>().mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    await expect(new AnthropicProvider({ apiKey: "secret", fetchImpl: timeoutFetch, timeoutMs: 1 }).complete(request))
      .rejects.toThrow(/timed out/);
    const errorFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(`secret ${"x".repeat(2000)}`, { status: 500 }));
    try {
      await new AnthropicProvider({ apiKey: "secret", fetchImpl: errorFetch }).complete(request);
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message.length).toBeLessThan(600);
    }
  });
});