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

/**
 * Refus d'un document légal produit depuis un pack pays non publié
 * (`PACK_NOT_PUBLISHED`, HTTP 409). Le message du serveur est exact mais long :
 * l'interface en garde le pack et son statut, et dit le reste en une phrase.
 *
 * `null` pour toute autre erreur — le message brut de l'API reste alors le
 * meilleur que nous ayons.
 */
export function packRefusal(err: unknown): { pack: string; status: string } | null {
  if (!(err instanceof ApiError) || err.code !== "PACK_NOT_PUBLISHED") return null;
  const d = (err.details ?? {}) as { pack?: unknown; status?: unknown };
  return {
    pack: typeof d.pack === "string" && d.pack.length > 0 ? d.pack : "—",
    status: typeof d.status === "string" && d.status.length > 0 ? d.status : "—",
  };
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
