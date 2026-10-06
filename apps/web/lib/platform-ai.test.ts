import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import {
  aiErrorState, emptyKeys, getPlatformAi, removePlatformAiKey, resetPlatformAi,
  saveBody, savePlatformAi, settingsDraft, testPlatformAi, type PlatformAiSettings,
} from "./platform-ai";

const settings: PlatformAiSettings = {
  revision: 7, defaultProvider: "anthropic", captureProvider: "openai", categorizeProvider: "gemini", encryptionAvailable: true,
  providers: [
    { id: "anthropic", name: "Anthropic", model: "claude-explicit", configured: true, source: "stored" },
    { id: "openai", name: "OpenAI", model: "gpt-explicit", configured: true, source: "environment" },
    { id: "gemini", name: "Gemini", model: "gemini-explicit", configured: false, source: "none" },
  ],
};
function mockResponse(body: unknown = settings, status = 200) {
  return vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status })));
}
afterEach(() => vi.unstubAllGlobals());
describe("platform AI API contract", () => {
  it("loads only safe settings through the authenticated proxy without a tenant scope", async () => {
    mockResponse();
    expect(await getPlatformAi()).toEqual(settings);
    expect(fetch).toHaveBeenCalledWith("/api/proxy/platform/ai", expect.objectContaining({
      credentials: "include", cache: "no-store", headers: expect.objectContaining({ "X-Tenant-Id": "" }),
    }));
    expect(vi.mocked(fetch).mock.calls[0][1]).not.toHaveProperty("body");
  });
  it("preserves explicit model names and omits blank keys", async () => {
    const draft = settingsDraft(settings);
    expect(draft.models).toEqual({ anthropic: "claude-explicit", openai: "gpt-explicit", gemini: "gemini-explicit" });
    expect(saveBody(7, draft, emptyKeys())).not.toHaveProperty("keys");
    mockResponse();
    await savePlatformAi(7, draft, { ...emptyKeys(), openai: "new-test-credential" });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toEqual({ revision: 7, ...draft, keys: { openai: "new-test-credential" } });
    expect(vi.mocked(fetch).mock.calls[0][1]!.method).toBe("PUT");
  });
  it("does not invent fallback models when the server has an empty model", () => {
    expect(settingsDraft({ ...settings, providers: settings.providers.map((p) => ({ ...p, model: "" })) }).models).toEqual(emptyKeys());
  });
  it("tests the explicit model using an optional unsaved key, otherwise the configured key", async () => {
    mockResponse({ ok: true, message: "Connexion confirmée." });
    await testPlatformAi("gemini", "my-explicit-model");
    expect(fetch).toHaveBeenLastCalledWith("/api/proxy/platform/ai/providers/gemini/test", expect.objectContaining({
      method: "POST", body: JSON.stringify({ model: "my-explicit-model" }),
    }));
    await testPlatformAi("openai", "another-model", "unsaved-test-key");
    expect(fetch).toHaveBeenLastCalledWith("/api/proxy/platform/ai/providers/openai/test", expect.objectContaining({
      body: JSON.stringify({ model: "another-model", apiKey: "unsaved-test-key" }),
    }));
  });
  it("includes the current revision for both destructive operations", async () => {
    mockResponse();
    await removePlatformAiKey("anthropic", 7);
    expect(fetch).toHaveBeenLastCalledWith("/api/proxy/platform/ai/providers/anthropic?revision=7", expect.objectContaining({ method: "DELETE" }));
    await resetPlatformAi(8);
    expect(fetch).toHaveBeenLastCalledWith("/api/proxy/platform/ai?revision=8", expect.objectContaining({ method: "DELETE" }));
  });
  it.each([[409, "conflict"], [503, "unavailable"], [401, "auth"], [403, "auth"], [422, "error"]] as const)("maps HTTP %s into actionable state without exposing credentials", (status, kind) => {
    const error = aiErrorState(new ApiError(status, "TEST", "secret-from-provider"));
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("secret-from-provider");
  });
  it("propagates failed test results and HTTP errors rather than faking success", async () => {
    mockResponse({ ok: false, message: "Modèle non reconnu." });
    expect(await testPlatformAi("openai", "unknown")).toEqual({ ok: false, message: "Modèle non reconnu." });
    mockResponse({ error: { code: "AI_UNAVAILABLE", message: "Unavailable" } }, 503);
    await expect(getPlatformAi()).rejects.toMatchObject({ status: 503 });
  });
});
