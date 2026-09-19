/**
 * Aides pures de l'assistant : questions suggérées, pied de page obligatoire
 * (« Ne remplace pas l'expert-comptable ») et mise en forme de la réponse.
 */
import type { AssistantToolName } from "@/components/documents/types";

export const ASSISTANT_FOOTER = "Ne remplace pas l'expert-comptable";

export const SUGGESTED_QUESTIONS = ["Qui me doit de l'argent ?", "Quelle est ma trésorerie ?", "Explique-moi le poste BI du bilan"] as const;

export const ASSISTANT_TOOLS: AssistantToolName[] = ["get_aged_receivables", "get_aged_payables", "get_cash_position", "get_trial_balance", "get_vat_summary", "explain_statement_line"];

const FOOTER_RE = /ne remplace pas l['’]expert[- ]comptable/i;

export function hasFooter(answer: string): boolean {
  return FOOTER_RE.test(answer);
}

/**
 * Sépare la réponse de son pied de page : le corps est affiché tel quel, le
 * pied de page est toujours rendu (ajouté s'il manque) et jamais dupliqué.
 */
export function splitAnswer(answer: string): { body: string; footer: string } {
  const lines = answer.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (FOOTER_RE.test(line) && line.trim().length <= ASSISTANT_FOOTER.length + 12) continue;
    kept.push(line);
  }
  const body = kept.join("\n").trim();
  return { body: body || answer.trim(), footer: ASSISTANT_FOOTER };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  tool?: AssistantToolName;
  arguments?: Record<string, unknown>;
  data?: unknown;
  at: string;
}

let seq = 0;
export function nextMessageId(): string {
  seq += 1;
  return `m${Date.now().toString(36)}-${seq}`;
}

/** Question exploitable : 2 à 2000 caractères (limites de l'API). */
export function normalizeQuestion(input: string): string | null {
  const q = input.trim().replace(/\s+/g, " ");
  return q.length >= 2 && q.length <= 2000 ? q : null;
}
