/**
 * Lectures côté serveur du module pièces. L'API n'expose pas `GET /documents` :
 * la liste des pièces est dérivée de la file de revue interrogée sur tous les
 * statuts et toutes les routes (une pièce par identifiant).
 */
import { apiTry, type ApiResult } from "@/lib/api";
import { PROPOSAL_STATUSES } from "./helpers";
import type { ReviewQueueGroup } from "./types";

export async function listAllGroups(limit = 200): Promise<ApiResult<ReviewQueueGroup[]>> {
  const results = await Promise.all(PROPOSAL_STATUSES.map((status) => apiTry<ReviewQueueGroup[]>("/proposals", { query: { status, route: "ALL", limit } })));
  const failure = results.find((r) => !r.ok);
  if (failure && !failure.ok) return failure;
  return { ok: true, data: results.flatMap((r) => (r.ok ? r.data : [])) };
}
