import { z } from "zod";
import type { AiGateway } from "@arcompt/ai-gateway";

/**
 * Appariement assisté par le modèle pour les libellés ambigus. Le modèle ne
 * voit que des données minimisées (dates, montants, libellés) et ne peut que
 * choisir parmi les candidats fournis ; le seuil de confiance reste appliqué
 * par le service, jamais par le modèle.
 */
export const ReconcileMatchSchema = z.object({
  candidate_line_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type ReconcileMatch = z.infer<typeof ReconcileMatchSchema>;

export interface LlmMatchRequest {
  transaction: { id: string; date: string; label: string; amount: string; reference: string | null };
  candidates: Array<{ lineId: string; date: string; label: string; amount: string; reference: string | null }>;
}

export interface LlmMatchResult {
  lineId: string | null;
  confidence: number;
  rationale?: string;
}

export interface LlmMatcher {
  match(ctx: { tenantId: string; userId?: string }, req: LlmMatchRequest): Promise<LlmMatchResult>;
}

export const RECONCILE_PROMPT_VERSION = "reconcile.v1";

const SYSTEM_PROMPT = `Tu es un assistant de rapprochement bancaire pour une PME de l'espace OHADA.
On te donne une ligne de relevé bancaire et des lignes d'écritures comptables candidates, toutes de même montant.
Choisis la ligne comptable qui correspond à la ligne de relevé en te fondant sur les libellés, références et dates.
Réponds uniquement en JSON : {"candidate_line_id": "<id ou null>", "confidence": <0..1>, "rationale": "<une phrase>"}.
Si aucun candidat n'est clairement le bon, renvoie candidate_line_id null avec une confiance basse. N'invente jamais d'identifiant.`;

/** Implémentation par la passerelle IA interne (journalisée, validée par schéma). */
export class AiLlmMatcher implements LlmMatcher {
  constructor(
    private readonly gateway: AiGateway,
    private readonly opts: { promptVersion?: string; maxTokens?: number } = {},
  ) {}

  async match(ctx: { tenantId: string; userId?: string }, req: LlmMatchRequest): Promise<LlmMatchResult> {
    const { data } = await this.gateway.callJson(
      ctx,
      {
        capability: "reconcile",
        promptVersion: this.opts.promptVersion ?? RECONCILE_PROMPT_VERSION,
        system: SYSTEM_PROMPT,
        input: req,
        maxTokens: this.opts.maxTokens ?? 300,
      },
      ReconcileMatchSchema,
    );
    const known = data.candidate_line_id !== null && req.candidates.some((c) => c.lineId === data.candidate_line_id);
    return { lineId: known ? data.candidate_line_id : null, confidence: known ? data.confidence : 0, rationale: data.rationale };
  }
}
