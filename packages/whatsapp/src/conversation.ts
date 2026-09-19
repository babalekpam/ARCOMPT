import { withTenant } from "@arcompt/db";
import type { Sql } from "postgres";
import { normalizePhone } from "./provider.js";

/**
 * Persistance des conversations. Le numéro est résolu SANS contexte tenant
 * via la fonction SECURITY DEFINER `whatsapp_resolve_phone` ; tout le reste
 * passe par withTenant (RLS).
 */
export interface ResolvedPhone {
  tenantId: string;
  userId: string;
  conversationId: string;
  /** Numéro de l'expéditeur (chiffres seuls), renseigné par le bot à la réception. */
  phone: string;
  /** Dernière session authentifiée dans l'application (ISO) ; null si jamais vérifié. */
  verifiedAt: string | null;
}

export interface ConversationState {
  pendingProposalId?: string;
  awaiting?: "ACCOUNT" | null;
  updatedAt?: string;
}

export interface OutboundLog {
  conversationId: string;
  direction: "IN" | "OUT";
  providerId?: string;
  type: "TEXT" | "IMAGE" | "AUDIO" | "DOCUMENT" | "INTERACTIVE";
  body: unknown;
  proposalId?: string;
}

export interface TenantCtx {
  tenantId: string;
  userId: string;
  organizationId?: string;
}

export interface ConversationStore {
  resolvePhone(phone: string): Promise<ResolvedPhone | null>;
  /** Marque l'identifiant comme traité ; renvoie true s'il l'était déjà (rejeu). */
  alreadyProcessed(providerId: string): Promise<boolean>;
  loadState(ctx: TenantCtx, conversationId: string): Promise<ConversationState>;
  saveState(ctx: TenantCtx, conversationId: string, state: ConversationState): Promise<void>;
  logMessage(ctx: TenantCtx, msg: OutboundLog): Promise<void>;
}

export class PgConversationStore implements ConversationStore {
  constructor(private readonly db: Sql) {}

  async resolvePhone(phone: string): Promise<ResolvedPhone | null> {
    const rows = await this.db`SELECT tenant_id, user_id, conversation_id, verified_at FROM whatsapp_resolve_phone(${normalizePhone(phone)})`;
    const r = rows[0];
    if (!r || !r.tenant_id || !r.user_id) return null;
    return { tenantId: r.tenant_id as string, userId: r.user_id as string, conversationId: r.conversation_id as string, phone: normalizePhone(phone), verifiedAt: r.verified_at ? new Date(r.verified_at as string).toISOString() : null };
  }

  async alreadyProcessed(providerId: string): Promise<boolean> {
    const rows = await this.db`INSERT INTO whatsapp_webhook_receipt (provider_id) VALUES (${providerId}) ON CONFLICT DO NOTHING RETURNING provider_id`;
    return rows.length === 0;
  }

  async loadState(ctx: TenantCtx, conversationId: string): Promise<ConversationState> {
    const rows = await withTenant(this.db, ctx, (tx) => tx`SELECT state FROM whatsapp_conversation WHERE tenant_id = ${ctx.tenantId} AND id = ${conversationId}`);
    return ((rows[0]?.state as ConversationState | undefined) ?? {}) as ConversationState;
  }

  async saveState(ctx: TenantCtx, conversationId: string, state: ConversationState): Promise<void> {
    await withTenant(this.db, ctx, (tx) => tx`UPDATE whatsapp_conversation SET state = ${tx.json({ ...state, updatedAt: new Date().toISOString() } as never)}, last_message_at = now() WHERE tenant_id = ${ctx.tenantId} AND id = ${conversationId}`);
  }

  async logMessage(ctx: TenantCtx, m: OutboundLog): Promise<void> {
    await withTenant(
      this.db,
      ctx,
      (tx) => tx`
        INSERT INTO whatsapp_message (tenant_id, conversation_id, direction, provider_id, type, body, proposal_id)
        VALUES (${ctx.tenantId}, ${m.conversationId}, ${m.direction}, ${m.providerId ?? null}, ${m.type}, ${tx.json(m.body as never)}, ${m.proposalId ?? null})
        ON CONFLICT DO NOTHING`,
    );
  }
}

/**
 * Lie un numéro à un dossier et un utilisateur (action réalisée depuis
 * l'application, par un utilisateur authentifié). `verified` horodate la
 * session authentifiée : les validations WhatsApp l'exigent (< 24 h).
 */
export async function linkPhone(db: Sql, ctx: TenantCtx, phone: string, opts: { userId?: string; verified?: boolean } = {}): Promise<{ conversationId: string }> {
  const digits = normalizePhone(phone);
  const userId = opts.userId ?? ctx.userId;
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx`
      INSERT INTO whatsapp_conversation (tenant_id, phone, user_id, verified_at)
      VALUES (${ctx.tenantId}, ${digits}, ${userId}, ${opts.verified ? tx`now()` : null})
      ON CONFLICT (phone) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id, verified_at = coalesce(EXCLUDED.verified_at, whatsapp_conversation.verified_at)
      RETURNING id`;
    return { conversationId: row!.id as string };
  });
}

/** Rafraîchit l'horodatage de session authentifiée du numéro (appelé après une connexion dans l'application). */
export async function markPhoneVerified(db: Sql, ctx: TenantCtx, phone: string): Promise<boolean> {
  const rows = await withTenant(db, ctx, (tx) => tx`UPDATE whatsapp_conversation SET verified_at = now() WHERE tenant_id = ${ctx.tenantId} AND phone = ${normalizePhone(phone)} RETURNING id`);
  return rows.length > 0;
}

/** Mémoire (tests, développement sans base). */
export class MemoryConversationStore implements ConversationStore {
  readonly phones = new Map<string, ResolvedPhone>();
  readonly states = new Map<string, ConversationState>();
  readonly messages: Array<OutboundLog & { tenantId: string }> = [];
  private readonly seen = new Set<string>();

  link(phone: string, r: ResolvedPhone): void {
    this.phones.set(normalizePhone(phone), r);
  }

  async resolvePhone(phone: string): Promise<ResolvedPhone | null> {
    return this.phones.get(normalizePhone(phone)) ?? null;
  }

  async alreadyProcessed(providerId: string): Promise<boolean> {
    if (this.seen.has(providerId)) return true;
    this.seen.add(providerId);
    return false;
  }

  async loadState(_ctx: TenantCtx, conversationId: string): Promise<ConversationState> {
    return this.states.get(conversationId) ?? {};
  }

  async saveState(_ctx: TenantCtx, conversationId: string, state: ConversationState): Promise<void> {
    this.states.set(conversationId, state);
  }

  async logMessage(ctx: TenantCtx, msg: OutboundLog): Promise<void> {
    this.messages.push({ ...msg, tenantId: ctx.tenantId });
  }
}
