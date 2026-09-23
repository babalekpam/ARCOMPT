// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ModelProvider, ModelRequest, ModelResponse } from "./gateway.js";

export interface OpenAIProviderOptions {
  /** Server-side only. Never pass this value to browser code. */
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_LENGTH = 500;

/**
 * OpenAI Chat Completions provider using the platform fetch implementation.
 * The provider deliberately does not attempt to recover from malformed
 * responses: callers must know when a provider response cannot be trusted.
 */
export class OpenAIProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OpenAIProviderOptions) {
    if (!opts.apiKey.trim()) throw new Error("OpenAI API key is required");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("OpenAI timeoutMs must be a positive finite number");
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const input = typeof req.input === "string" ? req.input : JSON.stringify(req.input);
    if (input === undefined) throw new Error("OpenAI request input cannot be undefined");

    const content: Array<Record<string, unknown>> = [{ type: "text", text: input }];
    for (const image of req.images ?? []) {
      if (!image.mediaType || !image.data) throw new Error("OpenAI image input is incomplete");
      content.push({
        type: "image_url",
        image_url: { url: `data:${image.mediaType};base64,${image.data}` },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const endpoint = this.baseUrl.endsWith("/v1")
        ? `${this.baseUrl}/chat/completions`
        : `${this.baseUrl}/v1/chat/completions`;
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `${req.system}\n\nRespond with a single valid JSON object and no surrounding text.`,
            },
            { role: "user", content },
          ],
          response_format: { type: "json_object" },
          max_tokens: req.maxTokens ?? 2048,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`OpenAI request timed out after ${this.timeoutMs}ms`);
      throw new Error(`OpenAI request failed: ${sanitizeError(error, this.opts.apiKey)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = sanitizeError(await readBoundedText(response), this.opts.apiKey);
      throw new Error(`OpenAI API error (${response.status}): ${detail || "request rejected"}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("OpenAI API returned invalid JSON");
    }
    return parseCompletion(body);
  }
}

function parseCompletion(value: unknown): ModelResponse {
  if (!isRecord(value) || typeof value.model !== "string" || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new Error("OpenAI API returned a malformed completion");
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") {
    throw new Error("OpenAI API returned a malformed message");
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== "stop") {
    throw new Error("OpenAI API returned an incomplete or refused completion");
  }
  if (!isRecord(value.usage) || !validTokenCount(value.usage.prompt_tokens) || !validTokenCount(value.usage.completion_tokens)) {
    throw new Error("OpenAI API returned malformed token usage");
  }
  return {
    text: choice.message.content,
    model: value.model,
    inputTokens: value.usage.prompt_tokens,
    outputTokens: value.usage.completion_tokens,
  };
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

function sanitizeError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const escapedSecret = secret?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message
    .replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(escapedSecret ? new RegExp(escapedSecret, "g") : /$^/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, MAX_ERROR_LENGTH);
}