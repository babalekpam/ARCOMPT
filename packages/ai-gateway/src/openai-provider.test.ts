import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "./openai-provider.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenAIProvider", () => {
  it("sends JSON mode and base64 images and returns usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    );
    const provider = new OpenAIProvider({ apiKey: "server-key", fetchImpl });
    const result = await provider.complete({
      capability: "capture",
      promptVersion: "1",
      system: "Extract fields",
      input: { document: "receipt" },
      images: [{ mediaType: "image/png", data: "YWJj" }],
    });

    expect(result).toEqual({ text: '{"ok":true}', model: "gpt-4o-mini", inputTokens: 12, outputTokens: 7 });
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    const init = call[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer server-key" });
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,YWJj" },
    });
  });

  it("fails explicitly for malformed completions", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ model: "x", choices: [] }));
    await expect(new OpenAIProvider({ apiKey: "key", fetchImpl }).complete({
      capability: "assistant",
      promptVersion: "1",
      system: "x",
      input: "x",
    })).rejects.toThrow("malformed completion");
  });

  it("rejects a truncated or refused completion even if it contains valid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      model: "gpt-4o-mini",
      choices: [{ finish_reason: "length", message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }));
    await expect(new OpenAIProvider({ apiKey: "key", fetchImpl }).complete({
      capability: "capture", promptVersion: "1", system: "x", input: "x",
    })).rejects.toThrow(/incomplete/);
  });

  it("bounds provider error text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("Bearer secret " + "x".repeat(2000), { status: 429, statusText: "Too Many Requests" }));
    await expect(new OpenAIProvider({ apiKey: "key", fetchImpl }).complete({
      capability: "assistant",
      promptVersion: "1",
      system: "x",
      input: "x",
    })).rejects.toThrow(/OpenAI API error \(429\)/);
    try {
      await new OpenAIProvider({ apiKey: "key", fetchImpl }).complete({ capability: "assistant", promptVersion: "1", system: "x", input: "x" });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error).length).toBeLessThan(600);
    }
  });
});