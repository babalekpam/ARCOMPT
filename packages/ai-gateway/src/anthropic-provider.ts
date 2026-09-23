// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ModelProvider, ModelRequest, ModelResponse } from "./gateway.js";

/**
 * Fournisseur Claude via l'API Messages (fetch natif, sans SDK). La clé API
 * ne quitte jamais le serveur ; aucune donnée client ne sert à entraîner un
 * modèle tiers.
 */
export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.model = opts.model ?? "claude-sonnet-5";
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const content: unknown[] = [];
    for (const img of req.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    content.push({ type: "text", text: typeof req.input === "string" ? req.input : JSON.stringify(req.input) });
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        system: `${req.system}\n\nRéponds uniquement par un objet JSON valide, sans texte autour.`,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status} : ${await res.text()}`);
    const body = (await res.json()) as { model: string; content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number } };
    return {
      text: body.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
      model: body.model,
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
    };
  }
}
