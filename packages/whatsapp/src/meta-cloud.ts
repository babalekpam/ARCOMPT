import { createHmac, timingSafeEqual } from "node:crypto";
import { parseMetaWebhook, type Button, type InboundMessage, type WhatsAppProvider } from "./provider.js";

export interface MetaCloudOptions {
  /** Base de l'API Graph (défaut https://graph.facebook.com/v21.0). */
  apiUrl?: string;
  token: string;
  verifyToken: string;
  phoneId: string;
  fetchImpl?: typeof fetch;
}

/** Meta WhatsApp Cloud API (Graph). */
export class MetaCloudProvider implements WhatsAppProvider {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MetaCloudOptions) {
    this.apiUrl = (opts.apiUrl ?? "https://graph.facebook.com/v21.0").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(payload: Record<string, unknown>): Promise<{ id: string }> {
    const res = await this.fetchImpl(`${this.apiUrl}/${this.opts.phoneId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });
    if (!res.ok) throw new Error(`WhatsApp Cloud API ${res.status} : ${await res.text()}`);
    const body = (await res.json()) as { messages?: Array<{ id: string }> };
    return { id: body.messages?.[0]?.id ?? "" };
  }

  sendText(to: string, text: string): Promise<{ id: string }> {
    return this.post({ to, type: "text", text: { body: text.slice(0, 4096), preview_url: false } });
  }

  sendButtons(to: string, body: string, buttons: Button[]): Promise<{ id: string }> {
    return this.post({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) },
      },
    });
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const headers = { authorization: `Bearer ${this.opts.token}` };
    const meta = await this.fetchImpl(`${this.apiUrl}/${encodeURIComponent(mediaId)}`, { headers });
    if (!meta.ok) throw new Error(`WhatsApp média ${meta.status} : ${await meta.text()}`);
    const info = (await meta.json()) as { url: string; mime_type?: string };
    const file = await this.fetchImpl(info.url, { headers });
    if (!file.ok) throw new Error(`WhatsApp téléchargement ${file.status}`);
    return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: info.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream" };
  }

  verifyWebhook(query: Record<string, string | undefined>): string | null {
    return query["hub.mode"] === "subscribe" && query["hub.verify_token"] === this.opts.verifyToken ? (query["hub.challenge"] ?? "") : null;
  }

  parseWebhook(body: unknown): InboundMessage[] {
    return parseMetaWebhook(body);
  }
}

/** Signature Meta : en-tête `X-Hub-Signature-256: sha256=<hmac hex du corps brut>`, comparaison en temps constant. */
export function verifyMetaSignature(rawBody: string | Uint8Array, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = signatureHeader.slice(7).toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export function signMetaBody(rawBody: string | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppProvider | null {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) return null;
  return new MetaCloudProvider({
    token: env.WHATSAPP_TOKEN,
    phoneId: env.WHATSAPP_PHONE_ID,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
    ...(env.WHATSAPP_API_URL ? { apiUrl: env.WHATSAPP_API_URL } : {}),
  });
}
