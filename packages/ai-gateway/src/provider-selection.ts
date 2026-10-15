// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { ModelProvider, ModelRequest } from "./gateway.js";

export const AI_PROVIDER_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
} as const;

export type AiProviderName = keyof typeof AI_PROVIDER_KEYS;
export type AiCapability = ModelRequest["capability"];

export interface AiProviderSelection {
  defaultProvider: AiProviderName;
  routes: Record<AiCapability, AiProviderName>;
  selected: AiProviderName[];
  /**
   * Explicit opt-in fallback (AI_FALLBACK_PROVIDER) : when the routed provider's
   * call fails, the call is retried once on this provider. Never inferred from
   * whichever keys happen to be present, and opportunistic : it activates only
   * when its own key is configured, so its absence never invalidates the config.
   */
  fallback: AiProviderName | null;
  /** Only the legacy, implicit no-key local configuration may simulate AI. */
  simulated: boolean;
  issues: string[];
}

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Explicit per-capability routing; never infer a provider from whatever key is present. */
export function resolveAiProviderSelection(env: NodeJS.ProcessEnv): AiProviderSelection {
  const issues: string[] = [];
  const parse = (variable: string, fallback: AiProviderName): AiProviderName => {
    const value = env[variable]?.trim().toLowerCase();
    if (!value) return fallback;
    if (Object.hasOwn(AI_PROVIDER_KEYS, value)) return value as AiProviderName;
    issues.push(`${variable} : fournisseur inconnu « ${value} » (anthropic, openai ou gemini attendu).`);
    return fallback;
  };
  const defaultProvider = parse("AI_PROVIDER", "anthropic");
  const capture = parse("AI_CAPTURE_PROVIDER", defaultProvider);
  const categorize = parse("AI_CATEGORIZE_PROVIDER", defaultProvider);
  const fallbackRaw = env.AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  const fallback = fallbackRaw
    ? (Object.hasOwn(AI_PROVIDER_KEYS, fallbackRaw) ? (fallbackRaw as AiProviderName) : null)
    : null;
  if (fallbackRaw && !fallback) issues.push(`AI_FALLBACK_PROVIDER : fournisseur inconnu « ${fallbackRaw} » (anthropic, openai ou gemini attendu).`);
  const routes: Record<AiCapability, AiProviderName> = {
    capture,
    categorize,
    reconcile: defaultProvider,
    assistant: defaultProvider,
    narrative: defaultProvider,
  };
  const selected = [...new Set(Object.values(routes))];
  const implicitOffline = !configured(env.AI_PROVIDER) && !configured(env.AI_CAPTURE_PROVIDER)
    && !configured(env.AI_CATEGORIZE_PROVIDER) && !configured(env.ANTHROPIC_API_KEY);
  if (!implicitOffline) {
    for (const provider of selected) {
      const keyName = AI_PROVIDER_KEYS[provider];
      if (!configured(env[keyName])) issues.push(`${keyName} : absente pour le fournisseur IA sélectionné (${provider}).`);
    }
  }
  return { defaultProvider, routes, selected, fallback, simulated: implicitOffline, issues };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps a provider with an explicit, opt-in fallback : if the primary call
 * throws (transport, authentication, configuration or quota error), the call
 * is retried once on the fallback provider and the result's model is tagged
 * "primary→fallback/model" so call logs show the failover. Without a distinct
 * fallback this returns the primary untouched — a failed call is surfaced,
 * never silently retried elsewhere.
 */
export function wrapWithFallback(
  primary: ModelProvider,
  primaryName: AiProviderName,
  fallback: ModelProvider | null,
  fallbackName: AiProviderName | null,
): ModelProvider {
  if (!fallback || !fallbackName || fallbackName === primaryName) return primary;
  return {
    async complete(req) {
      try {
        return await primary.complete(req);
      } catch (primaryError) {
        try {
          const result = await fallback.complete(req);
          return { ...result, model: `${primaryName}→${fallbackName}/${result.model}` };
        } catch (fallbackError) {
          throw new Error(
            `Échec du fournisseur ${primaryName} (${errorMessage(primaryError)}), puis du fournisseur de repli ${fallbackName} (${errorMessage(fallbackError)}).`,
          );
        }
      }
    },
  };
}

/**
 * One provider per capability, plus the explicit opt-in fallback above :
 * without AI_FALLBACK_PROVIDER, a failed call is surfaced, never retried elsewhere.
 */
export function createRoutedProvider(
  selection: AiProviderSelection,
  providers: Partial<Record<AiProviderName, ModelProvider>>,
): ModelProvider {
  if (selection.simulated || selection.issues.length) throw new Error(`Configuration IA invalide : ${selection.issues.join(" ")}`);
  for (const name of selection.selected) if (!providers[name]) throw new Error(`Fournisseur IA non initialisé : ${name}`);
  return {
    async complete(req) {
      const name = selection.routes[req.capability];
      const provider = providers[name]!;
      const fallbackName = selection.fallback && selection.fallback !== name ? selection.fallback : null;
      const wrapped = wrapWithFallback(provider, name, fallbackName ? (providers[fallbackName] ?? null) : null, fallbackName);
      const result = await wrapped.complete(req);
      // wrapWithFallback already tags failovers ("primary→fallback/model").
      return result.model.includes("→") ? result : { ...result, model: `${name}/${result.model}` };
    },
  };
}