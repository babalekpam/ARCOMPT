// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ModelProvider, ModelRequest, ModelResponse } from "./gateway.js";

/**
 * Gemini provider using the REST API directly.  The API key is deliberately
 * sent in a header (and never in a URL), so this class is intended for server
 * code only.
 */
export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_LENGTH = 1_000;

export class GeminiProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiProviderOptions) {
    if (!opts.apiKey.trim()) throw new Error("Gemini API key is required");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Gemini timeoutMs must be a positive number");
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const parts: GeminiPart[] = [];
    for (const image of req.images ?? []) {
      if (!image.mediaType || !image.data) throw new GeminiProviderError("Invalid image input");
      parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
    }
    let input: string;
    try {
      input = typeof req.input === "string" ? req.input : JSON.stringify(req.input);
    } catch {
      throw new GeminiProviderError("Gemini request input could not be serialized");
    }
    parts.push({ text: input });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${req.system}\n\nRespond with a valid JSON object only, without markdown fences or surrounding text.` }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new GeminiProviderError("Gemini request timed out");
      throw new GeminiProviderError(`Gemini request failed: ${safeErrorMessage(error, this.opts.apiKey)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new GeminiProviderError(`Gemini API ${response.status}: ${boundedResponseText(await response.text(), this.opts.apiKey)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GeminiProviderError("Gemini API returned malformed JSON");
    }
    return parseResponse(body, this.model);
  }
}

export class GeminiProviderError extends Error {
  override name = "GeminiProviderError";
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function parseResponse(value: unknown, requestedModel: string): ModelResponse {
  if (!isRecord(value)) throw new GeminiProviderError("Gemini API returned an invalid response");
  const promptFeedback = value.promptFeedback;
  if (isRecord(promptFeedback) && typeof promptFeedback.blockReason === "string") {
    throw new GeminiProviderError(`Gemini response blocked: ${promptFeedback.blockReason.slice(0, 100)}`);
  }
  const candidates = value.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0 || !isRecord(candidates[0])) {
    throw new GeminiProviderError("Gemini API returned no candidate");
  }
  const candidate = candidates[0];
  if (candidate.finishReason !== "STOP") {
    throw new GeminiProviderError(`Gemini response incomplete: ${String(candidate.finishReason).slice(0, 100)}`);
  }
  const content = candidate.content;
  const responseParts = isRecord(content) ? content.parts : undefined;
  if (!Array.isArray(responseParts)) throw new GeminiProviderError("Gemini API returned no content");
  const text = responseParts
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text.trim()) throw new GeminiProviderError("Gemini API returned no text output");

  const usage = value.usageMetadata;
  if (!isRecord(usage) || !validTokenCount(usage.promptTokenCount) || !validTokenCount(usage.candidatesTokenCount)) {
    throw new GeminiProviderError("Gemini API returned malformed token usage");
  }
  return {
    text,
    model: typeof value.modelVersion === "string" ? value.modelVersion
      : typeof value.model === "string" ? value.model : requestedModel,
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeErrorMessage(error: unknown, secret: string): string {
  return boundedResponseText(error instanceof Error ? error.message : "unknown error", secret);
}

function boundedResponseText(value: string, secret?: string): string {
  const sanitized = value.replace(/\s+/g, " ").replace(secret ? new RegExp(escapeRegExp(secret), "g") : /$^/g, "[REDACTED]");
  return sanitized.slice(0, MAX_ERROR_LENGTH);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}