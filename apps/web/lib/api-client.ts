"use client";
/**
 * Client API côté navigateur : passe par `/api/proxy/…`, qui ajoute les
 * en-têtes d'authentification côté serveur. Le navigateur ne voit jamais le
 * jeton. Fournit un hook `useMutation` minimal pour les îlots clients.
 */
import { useCallback, useState } from "react";
import { ApiError, parseApiResponse } from "./api-shared";

export { ApiError };

export class NetworkError extends Error {
  override name = "NetworkError";
}

export interface ClientInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export function proxyUrl(path: string, query?: ClientInit["query"]): string {
  const clean = path.replace(/^\/?(v1\/)?/, "");
  const qs = new URLSearchParams();
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return `/api/proxy/${clean}${s ? `?${s}` : ""}`;
}

export async function apiClient<T>(path: string, init: ClientInit = {}): Promise<T> {
  const { body, query, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(proxyUrl(path, query), {
      ...rest,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(headers as Record<string, string> | undefined) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : "réseau indisponible");
  }
  return parseApiResponse<T>(res);
}

export interface MutationState<T> {
  status: "idle" | "loading" | "success" | "error";
  data?: T;
  error?: ApiError | NetworkError | Error;
}

/** Hook de mutation minimal : `mutate(vars)` exécute `fn` et expose l'état. */
export function useMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const [state, setState] = useState<MutationState<TData>>({ status: "idle" });
  const mutate = useCallback(
    async (vars: TVars): Promise<TData | undefined> => {
      setState({ status: "loading" });
      try {
        const data = await fn(vars);
        setState({ status: "success", data });
        return data;
      } catch (e) {
        setState({ status: "error", error: e instanceof Error ? e : new Error(String(e)) });
        return undefined;
      }
    },
    [fn],
  );
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { ...state, mutate, reset, isLoading: state.status === "loading" };
}

/** Message d'erreur affichable, quelle que soit la cause. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return String(err);
}
