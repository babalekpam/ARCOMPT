/**
 * Aides pures de l'assistant : questions suggérées, pied de page obligatoire
 * (« Ne remplace pas l'expert-comptable ») et mise en forme de la réponse.
 */
import type { AssistantToolName } from "@/components/documents/types";

/**
 * Pied de page obligatoire, en français : c'est la forme sous laquelle la
 * passerelle d'IA le produit, et celle que `FOOTER_RE` reconnaît pour ne pas
 * l'afficher deux fois. Ce n'est PAS le texte montré à l'utilisateur — l'écran
 * affiche `assistant.footer` dans sa langue — mais le repère de détection.
 */
export const ASSISTANT_FOOTER = "Ne remplace pas l'expert-comptable";

/**
 * Questions suggérées, par clé de dictionnaire : l'écran les traduit avant de
 * les afficher ET avant de les envoyer, pour qu'une question posée en anglais
 * reçoive une réponse en anglais.
 */
export const SUGGESTED_QUESTION_KEYS = ["assistant.q.receivables", "assistant.q.cash", "assistant.q.explainLine"] as const;

export const ASSISTANT_TOOLS: AssistantToolName[] = ["get_aged_receivables", "get_aged_payables", "get_cash_position", "get_trial_balance", "get_vat_summary", "explain_statement_line"];

/** Le pied de page tel que la passerelle l'écrit, en français ou en anglais. */
const FOOTER_RE = /ne remplace pas l['’]expert[- ]comptable|not a substitute for (a |your )?(chartered )?accountant/i;

export function hasFooter(answer: string): boolean {
  return FOOTER_RE.test(answer);
}

/**
 * Sépare la réponse de son pied de page : le corps est affiché tel quel, le
 * pied de page est toujours rendu (ajouté s'il manque) et jamais dupliqué.
 *
 * `footer` est celui que l'appelant veut AFFICHER — donc traduit ; la
 * détection, elle, reconnaît les deux langues.
 */
export function splitAnswer(answer: string, footer: string = ASSISTANT_FOOTER): { body: string; footer: string } {
  const lines = answer.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (FOOTER_RE.test(line) && line.trim().length <= Math.max(ASSISTANT_FOOTER.length, footer.length) + 12) continue;
    kept.push(line);
  }
  const body = kept.join("\n").trim();
  return { body: body || answer.trim(), footer };
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
