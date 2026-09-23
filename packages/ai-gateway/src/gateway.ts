// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ZodType } from "zod";

/**
 * Passerelle IA interne : un seul point d'appel au modèle.
 *  - minimisation : seules les données nécessaires partent ;
 *  - sortie JSON validée par schéma ;
 *  - journal de chaque appel (entrée, sortie, version du prompt) ;
 *  - quotas par abonnement ;
 *  - fournisseur interchangeable (Claude par défaut, mock en test).
 */
export interface ModelRequest {
  capability: "capture" | "categorize" | "reconcile" | "assistant" | "narrative";
  promptVersion: string;
  system: string;
  input: unknown;
  /** Images en base64 (capture de pièces). */
  images?: Array<{ mediaType: string; data: string }>;
  maxTokens?: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export interface CallLogEntry {
  tenantId: string;
  userId?: string;
  capability: ModelRequest["capability"];
  model: string;
  promptVersion: string;
  input: unknown;
  output: unknown;
  schemaValid: boolean;
  confidence?: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  at: string;
}

export interface CallLogger {
  append(entry: CallLogEntry): Promise<void>;
}

export interface QuotaPolicy {
  /** Renvoie false si le dossier a épuisé son quota pour la capacité. */
  allow(tenantId: string, capability: ModelRequest["capability"]): Promise<boolean>;
}

export class AiGatewayError extends Error {
  override name = "AiGatewayError";
  constructor(
    readonly code: "QUOTA_EXCEEDED" | "INVALID_OUTPUT" | "PROVIDER_ERROR",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface AiGatewayOptions {
  provider: ModelProvider;
  logger: CallLogger;
  quota?: QuotaPolicy;
  now?: () => Date;
  /** Allowlisted route name for failure audit; never an API key or user input. */
  providerLabel?: (req: ModelRequest) => string;
}

export class AiGateway {
  constructor(private readonly opts: AiGatewayOptions) {}

  /** Appelle le modèle et valide la sortie JSON contre `schema`. */
  async callJson<T>(ctx: { tenantId: string; userId?: string }, req: ModelRequest, schema: ZodType<T>): Promise<{ data: T; raw: ModelResponse }> {
    if (this.opts.quota && !(await this.opts.quota.allow(ctx.tenantId, req.capability))) {
      throw new AiGatewayError("QUOTA_EXCEEDED", `Quota IA épuisé pour ${req.capability}`);
    }
    const started = Date.now();
    let raw: ModelResponse;
    try {
      raw = await this.opts.provider.complete(req);
    } catch (error) {
      // A failed model call must be auditable without storing provider error
      // bodies, credentials, images, or unvalidated financial document input.
      try {
        await this.opts.logger.append({
          tenantId: ctx.tenantId,
          ...(ctx.userId ? { userId: ctx.userId } : {}),
          capability: req.capability,
          model: this.opts.providerLabel?.(req) ?? "unknown",
          promptVersion: req.promptVersion,
          input: {},
          output: { outcome: "PROVIDER_ERROR", category: failureCategory(error) },
          schemaValid: false,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - started,
          at: (this.opts.now ?? (() => new Date()))().toISOString(),
        });
      } catch {
        // The operation has already failed; surface the audit outage without
        // leaking either the provider response or the database error.
        console.error("[arcompt] ai.provider_failure_audit_unavailable");
      }
      throw new AiGatewayError("PROVIDER_ERROR", "Le fournisseur IA n'a pas pu traiter la demande");
    }
    const latencyMs = Date.now() - started;
    const parsed = safeJson(raw.text);
    const result = parsed === undefined ? { success: false as const, error: "sortie non JSON" } : schema.safeParse(parsed);
    const confidence = parsed && typeof parsed === "object" && typeof (parsed as { confidence?: unknown }).confidence === "number" ? (parsed as { confidence: number }).confidence : undefined;
    await this.opts.logger.append({
      tenantId: ctx.tenantId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      capability: req.capability,
      model: raw.model,
      promptVersion: req.promptVersion,
      input: req.input,
      output: parsed ?? raw.text,
      schemaValid: result.success,
      ...(confidence !== undefined ? { confidence } : {}),
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      latencyMs,
      at: (this.opts.now ?? (() => new Date()))().toISOString(),
    });
    if (!result.success) {
      throw new AiGatewayError("INVALID_OUTPUT", "Sortie du modèle non conforme au schéma", "error" in result ? result.error : undefined);
    }
    return { data: result.data, raw };
  }
}

/** Coarse, allowlisted operational category; never persist raw provider errors. */
function failureCategory(error: unknown): "http_4xx" | "http_5xx" | "timeout" | "other" {
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/^(?:Anthropic API error|OpenAI API error|Gemini API)\s*\(?([45])\d{2}\b/i);
  if (status?.[1] === "4") return "http_4xx";
  if (status?.[1] === "5") return "http_5xx";
  if (/timed out/i.test(message)) return "timeout";
  return "other";
}

function safeJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Fournisseur de test : renvoie des réponses préparées. */
export class MockProvider implements ModelProvider {
  private queue: string[] = [];
  readonly calls: ModelRequest[] = [];
  constructor(responses: string[] = []) {
    this.queue.push(...responses);
  }
  enqueue(text: string): void {
    this.queue.push(text);
  }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const text = this.queue.shift();
    if (text === undefined) throw new Error("MockProvider : aucune réponse préparée");
    return { text, model: "mock", inputTokens: 10, outputTokens: 20 };
  }
}

export class MemoryCallLogger implements CallLogger {
  readonly entries: CallLogEntry[] = [];
  async append(entry: CallLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** Minimisation : retire les champs inutiles avant envoi au modèle. */
export function minimize<T extends Record<string, unknown>>(obj: T, allowed: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of allowed) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
