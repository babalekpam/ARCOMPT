import { AiGateway, AnthropicProvider, type ModelProvider, type ModelRequest, type ModelResponse } from "@arcompt/ai-gateway";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createStorageFromEnv, type Storage } from "@arcompt/storage";
import type { Sql } from "postgres";
import { PgCallLogger } from "./call-log.js";
import { DocumentsService } from "./service.js";
import { createScannerFromEnv, maxDocumentBytesFromEnv, type AntivirusScanner } from "./security.js";
import type { TenantContext } from "./types.js";

/**
 * Fournisseur hors ligne : renvoie une extraction et une catégorisation
 * plausibles pour que le développement local fonctionne sans clé API.
 * Jamais utilisé en production (ANTHROPIC_API_KEY requis).
 */
export class OfflineProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const text = JSON.stringify(cannedAnswer(req));
    return { text, model: "offline-mock", inputTokens: 0, outputTokens: 0 };
  }
}

function cannedAnswer(req: ModelRequest): unknown {
  switch (req.capability) {
    case "capture":
      return {
        document_type: "INVOICE",
        supplier_name: "Fournisseur démo",
        supplier_tax_id: null,
        customer_name: null,
        reference: `DEMO-${Date.now().toString().slice(-6)}`,
        date: new Date().toISOString().slice(0, 10),
        currency: "XOF",
        amount_excl_tax: "100000",
        vat_amount: "18000",
        amount_incl_tax: "118000",
        lines: [{ description: "Prestation (extraction simulée hors ligne)", quantity: "1", unit_price: "100000", amount: "100000" }],
        confidence: 0.5,
        notes: "Extraction simulée : ANTHROPIC_API_KEY absent",
      };
    case "categorize": {
      const input = req.input as { accounts?: Array<{ number: string }> };
      const first = input.accounts?.find((a) => a.number === "6057") ?? input.accounts?.find((a) => a.number.startsWith("6")) ?? input.accounts?.[0];
      return { account_number: first?.number ?? "6057", vat_code: null, confidence: 0.5, rationale: "Catégorisation simulée hors ligne" };
    }
    case "assistant":
      return typeof req.input === "object" && req.input && "tool_result" in (req.input as object)
        ? { answer: "Réponse simulée hors ligne : consultez les données jointes." }
        : { tool: "get_cash_position", arguments: {} };
    default:
      return { text: "Simulation hors ligne" };
  }
}

export interface DocumentsInfra {
  gateway: AiGateway;
  storage: Storage;
  scanner: AntivirusScanner;
  supportsPdf: boolean;
  maxBytes: number;
  baseCurrency: string;
}

let cached: DocumentsInfra | null = null;

/** Passerelle IA (Claude si ANTHROPIC_API_KEY, sinon simulation), stockage, antivirus : construits une fois par processus. */
export function createDocumentsInfraFromEnv(db: Sql, env: NodeJS.ProcessEnv = process.env): DocumentsInfra {
  if (cached) return cached;
  const provider: ModelProvider = env.ANTHROPIC_API_KEY ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, ...(env.AI_MODEL ? { model: env.AI_MODEL } : {}) }) : new OfflineProvider();
  cached = {
    gateway: new AiGateway({ provider, logger: new PgCallLogger(db) }),
    storage: createStorageFromEnv(env),
    scanner: createScannerFromEnv(env),
    supportsPdf: env.AI_PDF_SUPPORT === "1" || env.AI_PDF_SUPPORT === "true",
    maxBytes: maxDocumentBytesFromEnv(env),
    baseCurrency: env.DEFAULT_CURRENCY ?? "XOF",
  };
  return cached;
}

/** Réinitialise le cache (tests). */
export function resetDocumentsInfra(): void {
  cached = null;
}

export function createDocumentsServiceFromEnv(db: Sql, ctx: TenantContext, env: NodeJS.ProcessEnv = process.env): DocumentsService {
  const infra = createDocumentsInfraFromEnv(db, env);
  const ledger = new Ledger(new PostgresStore(db, { userId: ctx.userId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}) }), { baseCurrency: infra.baseCurrency });
  return new DocumentsService({ db, ctx, storage: infra.storage, gateway: infra.gateway, ledger, baseCurrency: infra.baseCurrency, supportsPdf: infra.supportsPdf, scanner: infra.scanner, maxBytes: infra.maxBytes });
}

