"use client";

import { apiClient, ApiError } from "./api-client";

export const AI_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type ProviderValues = Record<AiProvider, string>;
export interface AiRouting {
  defaultProvider: AiProvider;
  captureProvider: AiProvider;
  categorizeProvider: AiProvider;
}
export interface PlatformAiSettings extends AiRouting {
  revision: number;
  providers: {
    id: AiProvider;
    name: string;
    model: string;
    configured: boolean;
    source: "stored" | "environment" | "none";
  }[];
  encryptionAvailable: boolean;
}
export interface AiDraft extends AiRouting {
  models: ProviderValues;
}
export const emptyKeys = (): ProviderValues => ({ anthropic: "", openai: "", gemini: "" });
export function settingsDraft(settings: PlatformAiSettings): AiDraft {
  const models = emptyKeys();
  for (const provider of settings.providers) models[provider.id] = provider.model;
  return {
    defaultProvider: settings.defaultProvider,
    captureProvider: settings.captureProvider,
    categorizeProvider: settings.categorizeProvider,
    models,
  };
}
export function saveBody(revision: number, draft: AiDraft, keys: ProviderValues) {
  const changedKeys: Partial<ProviderValues> = {};
  for (const id of AI_PROVIDERS) if (keys[id]) changedKeys[id] = keys[id];
  return { revision, ...draft, ...(Object.keys(changedKeys).length ? { keys: changedKeys } : {}) };
}
const platformInit = { credentials: "include" as const, headers: { "X-Tenant-Id": "" }, cache: "no-store" as const };
export const getPlatformAi = () => apiClient<PlatformAiSettings>("/platform/ai", platformInit);
export const savePlatformAi = (revision: number, draft: AiDraft, keys: ProviderValues) =>
  apiClient<PlatformAiSettings>("/platform/ai", { ...platformInit, method: "PUT", body: saveBody(revision, draft, keys) });
export const testPlatformAi = (provider: AiProvider, model: string, apiKey?: string) =>
  apiClient<{ ok: boolean; message: string }>(`/platform/ai/providers/${provider}/test`, {
    ...platformInit, method: "POST", body: { model, ...(apiKey ? { apiKey } : {}) },
  });
export const removePlatformAiKey = (provider: AiProvider, revision: number) =>
  apiClient<void>(`/platform/ai/providers/${provider}`, { ...platformInit, method: "DELETE", query: { revision } });
export const resetPlatformAi = (revision: number) =>
  apiClient<void>("/platform/ai", { ...platformInit, method: "DELETE", query: { revision } });

export function aiErrorState(error: unknown) {
  const status = error instanceof ApiError ? error.status : undefined;
  const kind = status === 409 ? "conflict" : status === 503 ? "unavailable" : status === 401 || status === 403 ? "auth" : "error";
  // Never echo transport errors: a provider may include a submitted credential.
  const message = kind === "conflict"
    ? "La configuration a été modifiée par un autre administrateur. Rechargez la version actuelle avant toute nouvelle action."
    : kind === "unavailable"
      ? "Le stockage chiffré des paramètres est indisponible. Aucun changement n’a été enregistré. Réessayez lorsque le service sera rétabli."
      : kind === "auth"
        ? "Votre accès super-admin a expiré ou n’est plus autorisé. Vérifiez votre accès dans la sécurité du compte."
        : status === 400 || status === 422
          ? "Configuration refusée. Vérifiez les modèles et les clés des fournisseurs sélectionnés. Une suppression ou une réinitialisation est refusée si elle laisse un fournisseur actif sans clé valide."
          : "L’opération a échoué. Aucun succès n’est confirmé. Vérifiez la connexion puis réessayez.";
  return { kind, message };
}
