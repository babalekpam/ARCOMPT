// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { AiGateway } from "@arcompt/ai-gateway";
import type { CashExpenseInput, DocumentRecord, ExtractResult, ProposalLine, ProposalRecord, UploadInput } from "@arcompt/documents";
import { Money, type JournalEntry } from "@arcompt/ledger";
import type { ConversationState, ConversationStore, ResolvedPhone, TenantCtx } from "./conversation.js";
import type { Button, InboundMessage, WhatsAppProvider } from "./provider.js";
import { parseTextCommand, parseTextCommandWithLlm, type TextCommand } from "./text-command.js";

/** Sous-ensemble du DocumentsService utilisé par le bot (injectable pour les tests). */
export interface BotDocuments {
  upload(input: UploadInput): Promise<{ document: DocumentRecord; duplicate: boolean }>;
  extract(documentId: string): Promise<ExtractResult>;
  propose(documentId: string): Promise<ProposalRecord>;
  proposeCashExpense(input: CashExpenseInput): Promise<ProposalRecord>;
  validate(proposalId: string): Promise<{ proposal: ProposalRecord; entry: JournalEntry }>;
  correct(proposalId: string, lines: ProposalLine[]): Promise<{ proposal: ProposalRecord; entry: JournalEntry }>;
  reject(proposalId: string, reason?: string): Promise<ProposalRecord>;
  getProposal(proposalId: string): Promise<ProposalRecord>;
}

export interface WhatsAppBotOptions {
  provider: WhatsAppProvider;
  store: ConversationStore;
  documentsFor: (ctx: TenantCtx) => BotDocuments;
  /** Passerelle IA pour comprendre les textes que les regex ne couvrent pas. */
  gateway?: AiGateway;
  baseCurrency?: string;
  /** Durée de validité d'une session authentifiée pour les actions sensibles (défaut 24 h). */
  verificationTtlMs?: number;
  /** Âge maximal d'un message accepté (anti-rejeu, défaut 15 min). */
  maxMessageAgeMs?: number;
  now?: () => Date;
  log?: (event: string, detail?: unknown) => void;
}

export const ONBOARDING_TEXT =
  "Bonjour ! Ce numéro n'est pas encore relié à un dossier ARCOMPT. Connectez-vous à l'application, ouvrez Paramètres → WhatsApp et enregistrez ce numéro. Vous pourrez ensuite m'envoyer vos factures en photo ou des messages comme « j'ai payé 50 000 de carburant en espèces ».";
export const VERIFY_TEXT = "Pour valider une écriture depuis WhatsApp, confirmez d'abord votre identité en vous connectant à l'application ARCOMPT (session de moins de 24 h). La proposition reste en attente dans la file de revue.";
export const HELP_TEXT = "Je n'ai pas compris. Envoyez la photo d'une facture ou un message comme « j'ai payé 50 000 de carburant en espèces » (moyen : espèces, banque, mobile money).";

/**
 * Bot WhatsApp : photo → pièce → extraction → proposition ; texte → dépense
 * de caisse ; boutons VALIDER / CORRIGER. L'IA propose, l'humain valide.
 */
export class WhatsAppBot {
  private readonly now: () => Date;
  private readonly ttl: number;
  private readonly maxAge: number;
  private readonly currency: string;
  private readonly log: (event: string, detail?: unknown) => void;

  constructor(private readonly opts: WhatsAppBotOptions) {
    this.now = opts.now ?? (() => new Date());
    this.ttl = opts.verificationTtlMs ?? 24 * 3600 * 1000;
    this.maxAge = opts.maxMessageAgeMs ?? 15 * 60 * 1000;
    this.currency = opts.baseCurrency ?? "XOF";
    this.log = opts.log ?? (() => {});
  }

  /** Traite un message entrant ; ne lève jamais vers le webhook (les erreurs sont répondues à l'utilisateur et journalisées). */
  async handle(msg: InboundMessage): Promise<void> {
    if (msg.id && (await this.opts.store.alreadyProcessed(msg.id))) {
      this.log("whatsapp.replay", { id: msg.id });
      return;
    }
    if (msg.timestamp && this.now().getTime() - msg.timestamp * 1000 > this.maxAge) {
      this.log("whatsapp.stale", { id: msg.id, timestamp: msg.timestamp });
      return;
    }
    const resolved = await this.opts.store.resolvePhone(msg.from);
    if (!resolved) {
      await this.opts.provider.sendText(msg.from, ONBOARDING_TEXT);
      this.log("whatsapp.unknown_phone", { from: maskPhone(msg.from) });
      return;
    }
    const ctx: TenantCtx = { tenantId: resolved.tenantId, userId: resolved.userId };
    resolved.phone = msg.from;
    await this.opts.store.logMessage(ctx, { conversationId: resolved.conversationId, direction: "IN", providerId: msg.id, type: inboundLogType(msg), body: inboundBody(msg) });
    const docs = this.opts.documentsFor(ctx);
    const state = await this.opts.store.loadState(ctx, resolved.conversationId);
    try {
      switch (msg.type) {
        case "IMAGE":
        case "DOCUMENT":
          await this.onMedia(msg, resolved, ctx, docs, state);
          break;
        case "INTERACTIVE":
          await this.onButton(msg, resolved, ctx, docs, state);
          break;
        case "TEXT":
          await this.onText(msg, resolved, ctx, docs, state);
          break;
        case "AUDIO":
          await this.reply(resolved, ctx, "Les messages vocaux ne sont pas encore pris en charge : envoyez un texte ou une photo.");
          break;
        default:
          await this.reply(resolved, ctx, HELP_TEXT);
      }
    } catch (e) {
      this.log("whatsapp.error", { id: msg.id, error: (e as Error).message });
      await this.reply(resolved, ctx, `Désolé, je n'ai pas pu traiter ce message (${(e as { code?: string }).code ?? "erreur"}). Réessayez ou passez par l'application.`);
    }
  }

  private async onMedia(msg: InboundMessage, r: ResolvedPhone, ctx: TenantCtx, docs: BotDocuments, state: ConversationState): Promise<void> {
    const media = await this.opts.provider.downloadMedia(msg.mediaId ?? "");
    const { document, duplicate } = await docs.upload({ bytes: media.bytes, mimeType: media.mimeType, ...(msg.filename ? { filename: msg.filename } : {}), source: "WHATSAPP" });
    if (duplicate) {
      await this.reply(r, ctx, `Cette pièce a déjà été reçue (${document.filename ?? document.id.slice(0, 8)}). Aucune nouvelle écriture proposée.`);
      return;
    }
    const extraction = await docs.extract(document.id);
    if (extraction.needsOcr) {
      await this.reply(r, ctx, "Ce PDF ne peut pas être lu automatiquement pour l'instant : il est enregistré et sera traité depuis l'application.");
      return;
    }
    const proposal = await docs.propose(document.id);
    await this.presentProposal(r, ctx, proposal, state);
  }

  private async presentProposal(r: ResolvedPhone, ctx: TenantCtx, p: ProposalRecord, state: ConversationState): Promise<void> {
    const summary = this.summarize(p);
    if (p.route === "REJECTED" || p.status === "REJECTED") {
      const reasons = p.guardIssues.map((i) => i.message).join(" ; ");
      await this.reply(r, ctx, `${summary}\nProposition rejetée par les contrôles : ${reasons}. Corrigez la pièce depuis l'application.`, undefined, p.id);
      await this.opts.store.saveState(ctx, r.conversationId, clearPending(state));
      return;
    }
    const buttons: Button[] = [
      { id: `validate:${p.id}`, title: "VALIDER" },
      { id: `correct:${p.id}`, title: "CORRIGER" },
      { id: `reject:${p.id}`, title: "REJETER" },
    ];
    const note = p.route === "REVIEW_QUEUE" ? `\n(Confiance ${Math.round(p.confidence * 100)} % : ${p.guardIssues.map((i) => i.message).join(" ; ") || "revue conseillée"})` : "";
    await this.reply(r, ctx, `${summary}${note} Valider ?`, buttons, p.id);
    await this.opts.store.saveState(ctx, r.conversationId, { ...state, pendingProposalId: p.id, awaiting: null });
  }

  private async onButton(msg: InboundMessage, r: ResolvedPhone, ctx: TenantCtx, docs: BotDocuments, state: ConversationState): Promise<void> {
    const [action, id] = (msg.buttonId ?? "").split(":");
    const proposalId = id || state.pendingProposalId;
    if (!proposalId || !action) {
      await this.reply(r, ctx, HELP_TEXT);
      return;
    }
    if (action === "validate") {
      if (!this.isVerified(r)) {
        await this.reply(r, ctx, VERIFY_TEXT, undefined, proposalId);
        return;
      }
      const { entry } = await docs.validate(proposalId);
      await this.reply(r, ctx, `Écriture ${entry.journalCode} n°${entry.number} comptabilisée (${entry.date}). Merci !`, undefined, proposalId);
      await this.opts.store.saveState(ctx, r.conversationId, clearPending(state));
      return;
    }
    if (action === "correct") {
      await this.reply(r, ctx, "Quel compte faut-il utiliser ? Répondez par le numéro (ex. 6053) ou un mot-clé (carburant, loyer, téléphone…).", undefined, proposalId);
      await this.opts.store.saveState(ctx, r.conversationId, { ...state, pendingProposalId: proposalId, awaiting: "ACCOUNT" });
      return;
    }
    if (action === "reject") {
      await docs.reject(proposalId, "Rejet WhatsApp");
      await this.reply(r, ctx, "Proposition rejetée. Aucune écriture n'a été enregistrée.", undefined, proposalId);
      await this.opts.store.saveState(ctx, r.conversationId, clearPending(state));
      return;
    }
    await this.reply(r, ctx, HELP_TEXT);
  }

  private async onText(msg: InboundMessage, r: ResolvedPhone, ctx: TenantCtx, docs: BotDocuments, state: ConversationState): Promise<void> {
    const text = (msg.text ?? "").trim();
    if (state.awaiting === "ACCOUNT" && state.pendingProposalId) {
      await this.onAccountAnswer(text, r, ctx, docs, state);
      return;
    }
    let cmd: TextCommand | null = parseTextCommand(text, this.now);
    if (!cmd && this.opts.gateway && text.length > 3) cmd = await parseTextCommandWithLlm(this.opts.gateway, ctx, text);
    if (!cmd) {
      await this.reply(r, ctx, HELP_TEXT);
      return;
    }
    if (cmd.kind === "INCOME") {
      await this.reply(r, ctx, "Les encaissements ne sont pas encore saisissables par WhatsApp : utilisez l'application. Les dépenses, elles, fonctionnent (« j'ai payé 50 000 de carburant en espèces »).");
      return;
    }
    const proposal = await docs.proposeCashExpense({ amount: cmd.amount, label: cmd.label, means: cmd.means, ...(cmd.date ? { date: cmd.date } : {}), source: "WHATSAPP" });
    await this.presentProposal(r, ctx, proposal, state);
  }

  /** Réponse à « CORRIGER » : numéro de compte → écriture corrigée et comptabilisée (session vérifiée requise). */
  private async onAccountAnswer(text: string, r: ResolvedPhone, ctx: TenantCtx, docs: BotDocuments, state: ConversationState): Promise<void> {
    const proposalId = state.pendingProposalId!;
    const account = /^\s*(\d{2,13})\s*$/.exec(text)?.[1];
    if (!account) {
      await this.reply(r, ctx, "Indiquez le numéro de compte SYSCOHADA (ex. 6053 pour le carburant, 622 pour un loyer). Sinon, corrigez la proposition depuis l'application.", undefined, proposalId);
      return;
    }
    if (!this.isVerified(r)) {
      await this.reply(r, ctx, VERIFY_TEXT, undefined, proposalId);
      return;
    }
    const p = await docs.getProposal(proposalId);
    const lines: ProposalLine[] = p.proposal.lines.map((l) => {
      if (!/^[67]/.test(l.account_number)) return l;
      return { ...omit(l, "account_label"), account_number: account };
    });
    const { entry } = await docs.correct(proposalId, lines);
    await this.reply(r, ctx, `Corrigé : compte ${account}. Écriture ${entry.journalCode} n°${entry.number} comptabilisée. La prochaine fois, je proposerai ce compte directement.`, undefined, proposalId);
    await this.opts.store.saveState(ctx, r.conversationId, clearPending(state));
  }

  private isVerified(r: ResolvedPhone): boolean {
    return r.verifiedAt !== null && this.now().getTime() - Date.parse(r.verifiedAt) <= this.ttl;
  }

  /** « Facture CIE 118 000 FCFA du 05/03 → 6052 Fournitures non stockables – électricité. » */
  summarize(p: ProposalRecord): string {
    const x = p.extraction;
    const expense = p.proposal.lines.find((l) => /^[67]/.test(l.account_number));
    const ttc = x?.amount_incl_tax ? Money.parse(x.amount_incl_tax) : totalDebit(p.proposal.lines);
    const date = formatDay(p.proposal.date);
    const who = x?.supplier_name ?? p.proposal.label;
    const kind = x?.document_type === "RECEIPT" || p.documentId === null ? "Dépense" : "Facture";
    const account = expense ? `${expense.account_number}${expense.account_label ? ` ${expense.account_label}` : ""}` : "compte à préciser";
    return `${kind} ${who} ${formatAmount(ttc, this.currency)} du ${date} → ${account}.`;
  }

  private async reply(r: ResolvedPhone, ctx: TenantCtx, text: string, buttons?: Button[], proposalId?: string): Promise<void> {
    const to = r.phone;
    const sent = buttons ? await this.opts.provider.sendButtons(to, text, buttons) : await this.opts.provider.sendText(to, text);
    await this.opts.store.logMessage(ctx, { conversationId: r.conversationId, direction: "OUT", providerId: sent.id, type: buttons ? "INTERACTIVE" : "TEXT", body: { text, buttons: buttons ?? null }, ...(proposalId ? { proposalId } : {}) });
  }

}

function totalDebit(lines: ProposalLine[]): Money {
  let t = Money.zero();
  for (const l of lines) if (l.debit) t = t.add(Money.parse(l.debit));
  return t;
}

export function formatAmount(m: Money, currency: string): string {
  const unit = currency === "XOF" || currency === "XAF" ? "FCFA" : currency;
  return `${m.format(currency)} ${unit}`;
}

function formatDay(iso: string): string {
  const [, mm, dd] = iso.split("-");
  return `${dd}/${mm}`;
}

function maskPhone(p: string): string {
  return p.length > 4 ? `${"*".repeat(p.length - 4)}${p.slice(-4)}` : p;
}

function inboundLogType(m: InboundMessage): "TEXT" | "IMAGE" | "AUDIO" | "DOCUMENT" | "INTERACTIVE" {
  return m.type === "UNSUPPORTED" ? "TEXT" : m.type;
}

function inboundBody(m: InboundMessage): unknown {
  return { text: m.text ?? null, mediaId: m.mediaId ?? null, mimeType: m.mimeType ?? null, buttonId: m.buttonId ?? null };
}

function clearPending(state: ConversationState): ConversationState {
  return { ...omit(state, "pendingProposalId"), awaiting: null };
}

function omit<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const copy: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  delete copy[key as string];
  return copy as Omit<T, K>;
}
