import { AiGateway, CategorizationSchema } from "@arcompt/ai-gateway";
import type { Sql } from "postgres";
import { CategorizationMemoryStore } from "./memory.js";
import { CATEGORIZE_PROMPT_VERSION, CATEGORIZE_SYSTEM } from "./prompts.js";
import type { CategorizationInput, CategorizationResult, ChartAccountInfo, TenantContext } from "./types.js";

export interface CategorizationRule {
  id: string;
  pattern: string;
  accountNumber: string;
  vatCode: string | null;
  priority: number;
}

/** Une règle s'applique si son motif (regex insensible à la casse, sinon sous-chaîne) correspond au tiers ou au libellé. */
export function ruleMatches(rule: Pick<CategorizationRule, "pattern">, input: CategorizationInput): boolean {
  const haystack = `${input.partnerName ?? ""} ${input.description}`;
  try {
    return new RegExp(rule.pattern, "i").test(haystack);
  } catch {
    return haystack.toLowerCase().includes(rule.pattern.toLowerCase());
  }
}

export async function loadRules(tx: Sql, tenantId: string): Promise<CategorizationRule[]> {
  const rows = await tx`SELECT id, pattern, account_number, vat_code, priority FROM categorization_rule WHERE tenant_id = ${tenantId} AND active ORDER BY priority, created_at`;
  return rows.map((r) => ({ id: r.id as string, pattern: r.pattern as string, accountNumber: r.account_number as string, vatCode: (r.vat_code as string | null) ?? null, priority: Number(r.priority) }));
}

export async function loadChart(tx: Sql, tenantId: string): Promise<Map<string, ChartAccountInfo>> {
  const rows = await tx`SELECT number, label, postable, lettrable, active FROM account WHERE tenant_id = ${tenantId}`;
  return new Map(rows.map((r) => [r.number as string, { number: r.number as string, label: r.label as string, postable: Boolean(r.postable), lettrable: Boolean(r.lettrable), active: Boolean(r.active) }]));
}

export interface CategorizerDeps {
  ctx: TenantContext;
  gateway: AiGateway;
  memory: CategorizationMemoryStore;
}

/**
 * Pipeline de catégorisation : 1) règles du dossier, 2) mémoire des
 * validations/corrections (plus proche voisin), 3) modèle avec le plan de
 * comptes en contexte. Le compte renvoyé est vérifié ensuite par `checkProposal`.
 */
export async function categorize(tx: Sql, deps: CategorizerDeps, input: CategorizationInput, chart: Map<string, ChartAccountInfo>): Promise<CategorizationResult> {
  const rules = await loadRules(tx, deps.ctx.tenantId);
  const rule = rules.find((r) => ruleMatches(r, input));
  if (rule) {
    return { accountNumber: rule.accountNumber, vatCode: rule.vatCode, confidence: 0.98, rationale: `Règle du dossier « ${rule.pattern} »`, by: "RULE" };
  }

  const matches = await deps.memory.nearest(tx, { partnerName: input.partnerName, description: input.description });
  const best = matches[0];
  if (best) {
    const confidence = Math.min(0.97, 0.7 + 0.3 * best.score);
    const origin = best.source === "HUMAN_CORRECTION" ? "correction" : "validation";
    return { accountNumber: best.accountNumber, vatCode: best.vatCode, confidence, rationale: `Mémoire du dossier (${origin} précédente : ${best.partnerName ?? best.description})`, by: "MEMORY" };
  }

  const isRevenue = input.documentType === "OTHER" ? false : false;
  const candidates = [...chart.values()]
    .filter((a) => a.postable && a.active && (a.number.startsWith("6") || a.number.startsWith("7")))
    .map((a) => ({ number: a.number, label: a.label }));
  const { data } = await deps.gateway.callJson(
    { tenantId: deps.ctx.tenantId, userId: deps.ctx.userId },
    {
      capability: "categorize",
      promptVersion: CATEGORIZE_PROMPT_VERSION,
      system: CATEGORIZE_SYSTEM,
      input: {
        supplier: input.partnerName,
        description: input.description,
        amount: input.amount ?? null,
        document_type: input.documentType ?? null,
        expected_class: isRevenue ? 7 : 6,
        accounts: candidates,
      },
      maxTokens: 512,
    },
    CategorizationSchema,
  );
  return { accountNumber: data.account_number, vatCode: data.vat_code, confidence: data.confidence, rationale: data.rationale, by: "LLM" };
}
