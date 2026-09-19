/**
 * Partie du client API sans dépendance serveur (utilisable dans le navigateur).
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
}

export async function parseApiResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = (body as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText ?? "Erreur API", err?.details);
  }
  return body as T;
}
