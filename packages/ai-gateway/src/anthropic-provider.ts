// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ModelProvider, ModelRequest, ModelResponse } from "./gateway.js";

/**
 * Fournisseur Claude via l'API Messages (fetch natif, sans SDK). La clé API
 * ne quitte jamais le serveur ; aucune donnée client ne sert à entraîner un
 * modèle tiers.
 */
export interface AnthropicProviderOptions {
  /** Server-side only. Never pass this value to browser code. */
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_LENGTH = 500;

export class AnthropicProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AnthropicProviderOptions) {
    if (!opts.apiKey.trim()) throw new Error("Anthropic API key is required");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Anthropic timeoutMs must be a positive finite number");
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const content: Array<Record<string, unknown>> = [];
    for (const img of req.images ?? []) {
      if (!img.mediaType || !img.data) throw new Error("Anthropic image input is incomplete");
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    let input: string;
    try {
      input = typeof req.input === "string" ? req.input : JSON.stringify(req.input);
    } catch {
      throw new Error("Anthropic request input could not be serialized");
    }
    if (input === undefined) throw new Error("Anthropic request input cannot be undefined");
    content.push({ type: "text", text: input });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 2048,
          system: `${req.system}\n\nRéponds uniquement par un objet JSON valide, sans texte autour.`,
          messages: [{ role: "user", content }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Anthropic request timed out after ${this.timeoutMs}ms`);
      throw new Error(`Anthropic request failed: ${sanitizeError(error, this.opts.apiKey)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = sanitizeError(await readBoundedText(response), this.opts.apiKey);
      throw new Error(`Anthropic API error (${response.status}): ${detail || "request rejected"}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Anthropic API returned invalid JSON");
    }
    return parseResponse(body);
  }
}

function parseResponse(value: unknown): ModelResponse {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim() || !Array.isArray(value.content)) {
    throw new Error("Anthropic API returned a malformed response");
  }
  if (value.stop_reason !== "end_turn" &&
    !(value.stop_reason === "stop_sequence" && typeof value.stop_sequence === "string" && value.stop_sequence.length > 0)) {
    throw new Error("Anthropic API returned an incomplete response");
  }
  const text = value.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  if (!text.trim()) throw new Error("Anthropic API returned no text output");
  if (!isRecord(value.usage) || !validTokenCount(value.usage.input_tokens) || !validTokenCount(value.usage.output_tokens)) {
    throw new Error("Anthropic API returned malformed token usage");
  }
  return { text, model: value.model, inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function readBoundedText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_LENGTH);
  } catch {
    return "";
  }
}

function sanitizeError(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]")
    .replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/x-api-key[=:]\s*[^\s,}]+/gi, "x-api-key=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, MAX_ERROR_LENGTH);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
