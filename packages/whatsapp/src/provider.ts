// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Abstraction du canal WhatsApp Business. Le fournisseur (Meta Cloud API,
 * mock) normalise les messages entrants ; le bot ne connaît que ce format.
 * Tout message entrant est une entrée NON FIABLE (docs/SECURITY.md §9).
 */
export type InboundType = "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "INTERACTIVE" | "UNSUPPORTED";

export interface InboundMessage {
  /** Identifiant fournisseur (anti-rejeu). */
  id: string;
  /** Numéro de l'expéditeur, chiffres seuls (E.164 sans '+'). */
  from: string;
  /** Horodatage Unix en secondes, tel que fourni par le fournisseur. */
  timestamp: number;
  type: InboundType;
  text?: string;
  mediaId?: string;
  mimeType?: string;
  filename?: string;
  /** Réponse à un bouton : identifiant et libellé. */
  buttonId?: string;
  buttonTitle?: string;
  senderName?: string;
}

export interface Button {
  id: string;
  /** 20 caractères maximum (limite Meta). */
  title: string;
}

export interface WhatsAppProvider {
  sendText(to: string, text: string): Promise<{ id: string }>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<{ id: string }>;
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Vérification du webhook (GET) : renvoie le challenge à répondre, ou null si le jeton est mauvais. */
  verifyWebhook(query: Record<string, string | undefined>): string | null;
  /** Normalise le corps d'un webhook (POST) en messages entrants. */
  parseWebhook(body: unknown): InboundMessage[];
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/** Corps de webhook au format Meta Cloud API (aussi utilisé par le mock). */
export function parseMetaWebhook(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = body as { entry?: Array<{ changes?: Array<{ value?: MetaValue }> }> } | null;
  for (const entry of root?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages) {
        const base = { id: m.id, from: normalizePhone(m.from), timestamp: Number(m.timestamp) || 0, ...(names.get(m.from) ? { senderName: names.get(m.from)! } : {}) };
        switch (m.type) {
          case "text":
            out.push({ ...base, type: "TEXT", text: m.text?.body ?? "" });
            break;
          case "image":
            out.push({ ...base, type: "IMAGE", mediaId: m.image?.id ?? "", mimeType: m.image?.mime_type ?? "image/jpeg", ...(m.image?.caption ? { text: m.image.caption } : {}) });
            break;
          case "document":
            out.push({ ...base, type: "DOCUMENT", mediaId: m.document?.id ?? "", mimeType: m.document?.mime_type ?? "application/octet-stream", ...(m.document?.filename ? { filename: m.document.filename } : {}), ...(m.document?.caption ? { text: m.document.caption } : {}) });
            break;
          case "audio":
            out.push({ ...base, type: "AUDIO", mediaId: m.audio?.id ?? "", mimeType: m.audio?.mime_type ?? "audio/ogg" });
            break;
          case "interactive": {
            const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
            out.push({ ...base, type: "INTERACTIVE", buttonId: reply?.id ?? "", buttonTitle: reply?.title ?? "" });
            break;
          }
          case "button":
            out.push({ ...base, type: "INTERACTIVE", buttonId: m.button?.payload ?? "", buttonTitle: m.button?.text ?? "" });
            break;
          default:
            out.push({ ...base, type: "UNSUPPORTED" });
        }
      }
    }
  }
  return out;
}

interface MetaValue {
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: Array<{
    id: string;
    from: string;
    timestamp: string;
    type: string;
    text?: { body?: string };
    image?: { id?: string; mime_type?: string; caption?: string };
    document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
    audio?: { id?: string; mime_type?: string };
    interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
    button?: { payload?: string; text?: string };
  }>;
}

/** Fournisseur de test : enregistre les envois, sert des médias préparés. */
export class MockProvider implements WhatsAppProvider {
  readonly sent: Array<{ to: string; text: string; buttons?: Button[] }> = [];
  readonly media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  private seq = 0;

  constructor(private readonly verifyToken = "test-verify") {}

  async sendText(to: string, text: string): Promise<{ id: string }> {
    this.sent.push({ to, text });
    return { id: `mock-out-${++this.seq}` };
  }

  async sendButtons(to: string, body: string, buttons: Button[]): Promise<{ id: string }> {
    this.sent.push({ to, text: body, buttons });
    return { id: `mock-out-${++this.seq}` };
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`Média ${mediaId} inconnu`);
    return m;
  }

  verifyWebhook(query: Record<string, string | undefined>): string | null {
    return query["hub.mode"] === "subscribe" && query["hub.verify_token"] === this.verifyToken ? (query["hub.challenge"] ?? "") : null;
  }

  parseWebhook(body: unknown): InboundMessage[] {
    return parseMetaWebhook(body);
  }

  /** Dernier message envoyé (tests). */
  last(): { to: string; text: string; buttons?: Button[] } | undefined {
    return this.sent[this.sent.length - 1];
  }
}
