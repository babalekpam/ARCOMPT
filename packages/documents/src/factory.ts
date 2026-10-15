// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import {
  AiGateway, AnthropicProvider, GeminiProvider, OpenAIProvider, createRoutedProvider, resolveAiProviderSelection,
  wrapWithFallback, AI_PROVIDER_KEYS,
  type AiProviderName, type ModelProvider, type ModelRequest, type ModelResponse,
} from "@arcompt/ai-gateway";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createStorageFromEnv, type Storage } from "@arcompt/storage";
import type { Sql } from "postgres";
import { PgCallLogger } from "./call-log.js";
import { DocumentsService } from "./service.js";
import { createScannerFromEnv, guardSimulatedDependency, maxDocumentBytesFromEnv, type AntivirusScanner } from "./security.js";
import type { TenantContext } from "./types.js";
import { configuredAiProvider, runtimeAiEnv } from "./ai-settings.js";

/**
 * Fournisseur hors ligne : renvoie une extraction et une catégorisation
 * plausibles pour que le développement local fonctionne sans clé API.
 * Jamais utilisé en production sans opt-out explicite.
 */
export class OfflineProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const text = JSON.stringify(cannedAnswer(req));
    return { text, model: "offline-mock", inputTokens: 0, outputTokens: 0 };
  }
}

function cannedAnswer(req: ModelRequest): unknown {
  switch (req.capability) {
    case "capture":
      return {
        document_type: "INVOICE",
        supplier_name: "Fournisseur démo",
        supplier_tax_id: null,
        customer_name: null,
        reference: `DEMO-${Date.now().toString().slice(-6)}`,
        date: new Date().toISOString().slice(0, 10),
        currency: "XOF",
        amount_excl_tax: "100000",
        vat_amount: "18000",
        amount_incl_tax: "118000",
        lines: [{ description: "Prestation (extraction simulée hors ligne)", quantity: "1", unit_price: "100000", amount: "100000" }],
        confidence: 0.5,
        notes: "Extraction simulée : ANTHROPIC_API_KEY absent",
      };
    case "categorize": {
      const input = req.input as { accounts?: Array<{ number: string }> };
      const first = input.accounts?.find((a) => a.number === "6057") ?? input.accounts?.find((a) => a.number.startsWith("6")) ?? input.accounts?.[0];
      return { account_number: first?.number ?? "6057", vat_code: null, confidence: 0.5, rationale: "Catégorisation simulée hors ligne" };
    }
    case "assistant":
      return typeof req.input === "object" && req.input && "tool_result" in (req.input as object)
        ? { answer: "Réponse simulée hors ligne : consultez les données jointes." }
        : { tool: "get_cash_position", arguments: {} };
    default:
      return { text: "Simulation hors ligne" };
  }
}

export interface DocumentsInfra {
  gateway: AiGateway;
  storage: Storage;
  scanner: AntivirusScanner;
  supportsPdf: boolean;
  maxBytes: number;
  baseCurrency: string;
}

let cached: DocumentsInfra | null = null;
let storedAiSettingsEnabled = false;
/** Enable persistent server-side settings in API and worker entrypoints. */
export function enableStoredAiSettings(): void {
  storedAiSettingsEnabled = true;
  cached = null;
}

/** Repli hors ligne : autorisé hors production, refusé en production sans opt-out explicite. */
function offlineProvider(env: NodeJS.ProcessEnv): ModelProvider {
  guardSimulatedDependency({
    env,
    simulated: "l'extraction IA des pièces (fournisseur, référence et montants inventés, versés à la file de validation puis au grand livre)",
    missing: "ANTHROPIC_API_KEY est absente",
    optOut: "ALLOW_INSECURE_AI",
  });
  return new OfflineProvider();
}

/**
 * Passerelle IA (routage explicite Claude/OpenAI/Gemini), stockage,
 * antivirus : construits une fois par processus. En production, la simulation
 * est refusée (sauf ALLOW_INSECURE_AI=1) : l'extraction hors ligne inventerait
 * fournisseur et montants, qui finiraient au grand livre après une validation.
 */
export function createDocumentsInfraFromEnv(db: Sql, env: NodeJS.ProcessEnv = process.env): DocumentsInfra {
  if (cached) return cached;
  const provider = storedAiSettingsEnabled ? {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const effective = await runtimeAiEnv(db, env);
      const selection = resolveAiProviderSelection(effective);
      if (selection.issues.length) throw new Error("Configuration IA persistée invalide");
      if (selection.simulated) return offlineProvider(effective).complete(req);
      const routedName = selection.routes[req.capability];
      const primary = configuredAiProvider(routedName, effective);
      // Explicit opt-in fallback (AI_FALLBACK_PROVIDER) : opportunistic, it only
      // activates when its key is configured in the effective (persisted) settings.
      const fallbackName = selection.fallback && selection.fallback !== routedName
        && (effective[AI_PROVIDER_KEYS[selection.fallback]] ?? "").trim()
        ? selection.fallback
        : null;
      return wrapWithFallback(
        primary, routedName,
        fallbackName ? configuredAiProvider(fallbackName, effective) : null, fallbackName,
      ).complete(req);
    },
  } : createEnvironmentAiProvider(env);
  cached = {
    gateway: new AiGateway({
      provider, logger: new PgCallLogger(db),
      ...(storedAiSettingsEnabled ? {} : { providerLabel: (req: ModelRequest) => {
        const selection=resolveAiProviderSelection(env);
        return selection.simulated ? "offline" : selection.routes[req.capability];
      } }),
    }),
    storage: createStorageFromEnv(env),
    scanner: createScannerFromEnv(env),
    supportsPdf: env.AI_PDF_SUPPORT === "1" || env.AI_PDF_SUPPORT === "true",
    maxBytes: maxDocumentBytesFromEnv(env),
    baseCurrency: env.DEFAULT_CURRENCY ?? "XOF",
  };
  return cached;
}

function createEnvironmentAiProvider(env: NodeJS.ProcessEnv): ModelProvider {
  const selection = resolveAiProviderSelection(env);
  if (selection.issues.length) throw new Error(`Configuration IA invalide : ${selection.issues.join(" ")}`);
  const providers: Partial<Record<AiProviderName, ModelProvider>> = {};
  const providerNames = selection.simulated ? [] : [...new Set([...selection.selected, ...(selection.fallback ? [selection.fallback] : [])])];
  for (const name of providerNames) {
    // The fallback is opportunistic : never instantiate it without its key.
    if (name === selection.fallback && !selection.selected.includes(name) && !(env[AI_PROVIDER_KEYS[name]] ?? "").trim()) continue;
    const anthropicModel = env.AI_ANTHROPIC_MODEL || env.AI_MODEL;
    if (name === "anthropic") providers.anthropic = new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY!,
      ...(anthropicModel ? { model: anthropicModel } : {}),
    });
    if (name === "openai") providers.openai = new OpenAIProvider({
      apiKey: env.OPENAI_API_KEY!,
      ...(env.AI_OPENAI_MODEL ? { model: env.AI_OPENAI_MODEL } : {}),
    });
    if (name === "gemini") providers.gemini = new GeminiProvider({
      apiKey: env.GEMINI_API_KEY!,
      ...(env.AI_GEMINI_MODEL ? { model: env.AI_GEMINI_MODEL } : {}),
    });
  }
  return selection.simulated ? offlineProvider(env) : createRoutedProvider(selection, providers);
}

/** Réinitialise le cache (tests). */
export function resetDocumentsInfra(): void {
  cached = null;
  storedAiSettingsEnabled = false;
}

export function createDocumentsServiceFromEnv(db: Sql, ctx: TenantContext, env: NodeJS.ProcessEnv = process.env): DocumentsService {
  const infra = createDocumentsInfraFromEnv(db, env);
  const ledger = new Ledger(new PostgresStore(db, { userId: ctx.userId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }), { baseCurrency: infra.baseCurrency });
  return new DocumentsService({ db, ctx, storage: infra.storage, gateway: infra.gateway, ledger, baseCurrency: infra.baseCurrency, supportsPdf: infra.supportsPdf, scanner: infra.scanner, maxBytes: infra.maxBytes });
}

