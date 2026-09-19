/**
 * Client API côté serveur (composants serveur, route handlers).
 *
 * - lit le contexte d'authentification (cookies / session) et ajoute les en-têtes ;
 * - cible API_URL (ou NEXT_PUBLIC_API_URL) ;
 * - transforme les réponses `{ error: { code, message } }` en ApiError typée ;
 * - `apiTry` renvoie un résultat discriminé pour les écrans qui doivent rester
 *   utilisables quand l'API est absente (états vides plutôt qu'un crash).
 */
import { ApiError, parseApiResponse } from "./api-shared";
import { getAuthContext } from "./auth";
import { config } from "./config";

export { ApiError };
export type { ApiErrorBody } from "./api-shared";

export class ApiUnreachableError extends Error {
  override name = "ApiUnreachableError";
  constructor(readonly url: string, cause: unknown) {
    super(`API injoignable : ${url}`);
    this.cause = cause;
  }
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError | ApiUnreachableError };

export interface ApiInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Paramètres de requête ; les valeurs undefined sont ignorées. */
  query?: Record<string, string | number | undefined>;
}

export function buildUrl(base: string, path: string, query?: ApiInit["query"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base.endsWith("/") ? base : `${base}/`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  return url.toString();
}

/** Appel API authentifié ; lève ApiError / ApiUnreachableError. */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  const ctx = await getAuthContext();
  const { body, query, headers, ...rest } = init;
  const url = buildUrl(config.apiUrl(), path.startsWith("/v1") ? path : `/v1${path.startsWith("/") ? path : `/${path}`}`, query);
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(ctx?.headers ?? {}),
        ...(headers as Record<string, string> | undefined),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new ApiUnreachableError(url, e);
  }
  return parseApiResponse<T>(res);
}

/** Variante sans exception, pour les écrans qui affichent un état vide. */
export async function apiTry<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await apiFetch<T>(path, init) };
  } catch (e) {
    if (e instanceof ApiError || e instanceof ApiUnreachableError) return { ok: false, error: e };
    throw e;
  }
}

/** Message lisible pour une erreur d'API (les écrans le passent à t()). */
export function describeApiError(err: ApiError | ApiUnreachableError): { key: "common.apiError" | "common.unreachable"; params: Record<string, string> } {
  if (err instanceof ApiUnreachableError) return { key: "common.unreachable", params: { url: config.apiUrl() } };
  return { key: "common.apiError", params: { code: err.code, message: err.message } };
}
