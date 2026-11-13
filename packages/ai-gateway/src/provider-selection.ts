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
  return { defaultProvider, routes, selected, simulated: implicitOffline, issues };
}

/** One provider per capability. A failed call is surfaced, never retried elsewhere. */
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
      const result = await provider.complete(req);
      return { ...result, model: `${name}/${result.model}` };
    },
  };
}