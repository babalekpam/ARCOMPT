// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { withTenant } from "@arcompt/db";
import type { CallLogEntry, CallLogger } from "@arcompt/ai-gateway";
import type { Sql } from "postgres";
import { maskForLog } from "./security.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Journal des appels IA dans `ai_call_log`, via le contexte tenant (RLS). */
export class PgCallLogger implements CallLogger {
  constructor(private readonly db: Sql) {}

  async append(e: CallLogEntry): Promise<void> {
    const userId = e.userId && UUID.test(e.userId) ? e.userId : null;
    await withTenant(this.db, { tenantId: e.tenantId, ...(userId ? { userId } : {}) }, async (tx) => {
      await tx`
        INSERT INTO ai_call_log (tenant_id, user_id, capability, model, prompt_version, input, output, schema_valid, confidence, input_tokens, output_tokens, latency_ms, at)
        VALUES (${e.tenantId}, ${userId}, ${e.capability}, ${e.model}, ${e.promptVersion}, ${tx.json(maskForLog(e.input) as never)}, ${tx.json(minimizeOutput(e.output) as never)},
                ${e.schemaValid}, ${e.confidence ?? null}, ${e.inputTokens}, ${e.outputTokens}, ${e.latencyMs}, ${e.at})`;
    });
  }
}

/** La sortie validée par schéma est conservée telle quelle, tronquée si volumineuse (les montants y sont nécessaires à la relecture). */
function minimizeOutput(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "string") return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
  return v;
}
