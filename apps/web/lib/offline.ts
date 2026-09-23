/**
 * File de brouillons hors ligne (docs/SECURITY.md §11).
 *
 * - Hors ligne = brouillons seulement : la file ne rejoue que `POST /v1/entries`
 *   avec `validate: false`, jamais une validation ni un paiement.
 * - Stockage IndexedDB chiffré : le contenu de chaque brouillon est chiffré en
 *   AES-GCM avec une clé non extractable dérivée de la session (HKDF) et
 *   conservée dans IndexedDB ; seuls l'identifiant client, la date et l'id de
 *   clé restent en clair.
 * - Idempotence : chaque brouillon porte un `clientId` (UUID généré côté client)
 *   que l'API utilise pour dédupliquer les renvois.
 * - Aucun identifiant de dossier dans le corps : le tenant vient des en-têtes
 *   ajoutés par le proxy serveur.
 *
 * Le module est découpé en interfaces (KeyValueStore, Cipher) pour être testé
 * sans navigateur : `MemoryStore` + WebCrypto de Node.
 */

export interface EntryLineDraft {
  accountNumber: string;
  debit?: string;
  credit?: string;
  label?: string;
  partnerId?: string;
  vatCode?: string;
  analyticCode?: string;
}

/** Corps envoyé à POST /v1/entries. Jamais de tenantId ici. */
export interface EntryDraftInput {
  journalCode: string;
  date: string;
  reference?: string;
  label: string;
  source: "MANUAL";
  lines: EntryLineDraft[];
}

export interface StoredDraft {
  clientId: string;
  createdAt: string;
  keyId: string;
  /** IV et contenu chiffré, en base64. */
  iv: string;
  data: string;
  lastError?: string;
  attempts: number;
}

export interface QueuedDraft {
  clientId: string;
  createdAt: string;
  /** Absent si la clé de session courante ne peut pas déchiffrer le brouillon. */
  input?: EntryDraftInput;
  lastError?: string;
  attempts: number;
}

export interface KeyValueStore<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Cipher {
  readonly keyId: string;
  encrypt(plaintext: string): Promise<{ iv: string; data: string }>;
  decrypt(iv: string, data: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

export function generateClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Repli (contextes non sécurisés) : UUID v4 pseudo-aléatoire.
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Retire toute trace d'identifiant de dossier d'un corps avant stockage ou envoi. */
export function sanitizeDraftInput(input: EntryDraftInput): EntryDraftInput {
  const { journalCode, date, reference, label, lines } = input;
  return {
    journalCode,
    date,
    ...(reference ? { reference } : {}),
    label,
    source: "MANUAL",
    lines: lines.map((l) => ({
      accountNumber: l.accountNumber,
      ...(l.debit ? { debit: l.debit } : {}),
      ...(l.credit ? { credit: l.credit } : {}),
      ...(l.label ? { label: l.label } : {}),
      ...(l.partnerId ? { partnerId: l.partnerId } : {}),
      ...(l.vatCode ? { vatCode: l.vatCode } : {}),
      ...(l.analyticCode ? { analyticCode: l.analyticCode } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** Store en mémoire (tests, rendu serveur). */
export class MemoryStore<T = unknown> implements KeyValueStore<T> {
  private readonly map = new Map<string, T>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, value: T) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
}

export const IDB_NAME = "arcompt-offline";
/**
 * Version 2 : ajout des magasins de la file d'opérations généralisée
 * (`operations`, `links`) et du cliché de référence (`snapshot`). Les magasins
 * de la version 1 sont conservés tels quels — un appareil qui revient avec des
 * brouillons en attente ne doit pas les perdre en se mettant à jour.
 */
export const IDB_VERSION = 2;
export const IDB_STORES = ["drafts", "keys", "recent", "operations", "links", "snapshot"] as const;
export type IdbStoreName = (typeof IDB_STORES)[number];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of IDB_STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB indisponible"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB : requête échouée"));
  });
}

/** Store IndexedDB brut (sans dépendance), un object store par instance. */
export class IndexedDbStore<T = unknown> implements KeyValueStore<T> {
  private db: Promise<IDBDatabase> | null = null;
  constructor(private readonly storeName: IdbStoreName) {}

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    this.db ??= openDatabase();
    const db = await this.db;
    return db.transaction(this.storeName, mode).objectStore(this.storeName);
  }
  async get(key: string) {
    return request<T | undefined>((await this.tx("readonly")).get(key));
  }
  async set(key: string, value: T) {
    await request((await this.tx("readwrite")).put(value, key));
  }
  async delete(key: string) {
    await request((await this.tx("readwrite")).delete(key));
  }
  async keys() {
    return (await request((await this.tx("readonly")).getAllKeys())).map(String);
  }
}

// ---------------------------------------------------------------------------
// Chiffrement
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Identifiant public de la clé : empreinte du matériau de session (jamais le matériau lui-même). */
export async function keyIdFor(material: Uint8Array): Promise<string> {
  return (await sha256Hex(material)).slice(0, 16);
}

/**
 * Dérive une clé AES-GCM 256 bits NON extractable depuis le matériau de session
 * (HKDF-SHA256). Le matériau n'est jamais conservé ; seule la CryptoKey l'est.
 */
export async function deriveSessionKey(material: Uint8Array, salt = "arcompt-offline-v1"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", material as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode("drafts") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Chiffrement AES-GCM WebCrypto (navigateur et Node ≥ 20). */
export class WebCryptoCipher implements Cipher {
  constructor(
    private readonly key: CryptoKey,
    readonly keyId: string,
  ) {}

  static async fromMaterial(material: Uint8Array): Promise<WebCryptoCipher> {
    return new WebCryptoCipher(await deriveSessionKey(material), await keyIdFor(material));
  }

  async encrypt(plaintext: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, encoder.encode(plaintext));
    return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }

  async decrypt(iv: string, data: string) {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) as BufferSource }, this.key, fromBase64(data) as BufferSource);
    return decoder.decode(plain);
  }
}

/**
 * Obtient ou crée la clé de session dans le store `keys` d'IndexedDB. La clé
 * stockée est non extractable : IndexedDB la conserve par clonage structuré.
 */
export async function loadOrCreateCipher(keys: KeyValueStore<CryptoKey>, material: Uint8Array): Promise<WebCryptoCipher> {
  const keyId = await keyIdFor(material);
  const existing = await keys.get(keyId);
  if (existing) return new WebCryptoCipher(existing, keyId);
  const key = await deriveSessionKey(material);
  await keys.set(keyId, key);
  // Une seule clé à la fois : les clés d'anciennes sessions sont purgées.
  for (const k of await keys.keys()) if (k !== keyId) await keys.delete(k);
  return new WebCryptoCipher(key, keyId);
}

// ---------------------------------------------------------------------------
// File de brouillons
// ---------------------------------------------------------------------------

export interface ReplayResult {
  sent: string[];
  failed: Array<{ clientId: string; message: string; retryable: boolean }>;
}

export interface SendResult {
  /** Identifiant serveur de l'écriture créée (pour l'historique local). */
  id?: string;
}

export interface DraftQueue {
  enqueue(input: EntryDraftInput, clientId?: string): Promise<QueuedDraft>;
  list(): Promise<QueuedDraft[]>;
  count(): Promise<number>;
  remove(clientId: string): Promise<void>;
  /**
   * Rejoue les brouillons dans l'ordre de création. `send` reçoit le corps à
   * poster (avec clientId et validate:false) ; une erreur `retryable` (réseau)
   * arrête le rejeu, une erreur métier laisse le brouillon en file avec son message.
   */
  replay(send: (body: EntryDraftInput & { clientId: string; validate: false }) => Promise<SendResult | void>): Promise<ReplayResult>;
}

export class RetryableError extends Error {
  override name = "RetryableError";
}

export function createDraftQueue(deps: { store: KeyValueStore<StoredDraft>; cipher: Cipher; now?: () => Date }): DraftQueue {
  const now = deps.now ?? (() => new Date());

  async function readAll(): Promise<StoredDraft[]> {
    const out: StoredDraft[] = [];
    for (const k of await deps.store.keys()) {
      const d = await deps.store.get(k);
      if (d) out.push(d);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.clientId.localeCompare(b.clientId));
  }

  async function open(d: StoredDraft): Promise<QueuedDraft> {
    const base = { clientId: d.clientId, createdAt: d.createdAt, attempts: d.attempts, ...(d.lastError ? { lastError: d.lastError } : {}) };
    if (d.keyId !== deps.cipher.keyId) return base;
    try {
      return { ...base, input: JSON.parse(await deps.cipher.decrypt(d.iv, d.data)) as EntryDraftInput };
    } catch {
      return base;
    }
  }

  return {
    async enqueue(input, clientId = generateClientId()) {
      const clean = sanitizeDraftInput(input);
      const { iv, data } = await deps.cipher.encrypt(JSON.stringify(clean));
      const stored: StoredDraft = { clientId, createdAt: now().toISOString(), keyId: deps.cipher.keyId, iv, data, attempts: 0 };
      await deps.store.set(clientId, stored);
      return { clientId, createdAt: stored.createdAt, input: clean, attempts: 0 };
    },
    async list() {
      return Promise.all((await readAll()).map(open));
    },
    async count() {
      return (await deps.store.keys()).length;
    },
    async remove(clientId) {
      await deps.store.delete(clientId);
    },
    async replay(send) {
      const result: ReplayResult = { sent: [], failed: [] };
      for (const stored of await readAll()) {
        const draft = await open(stored);
        if (!draft.input) {
          result.failed.push({ clientId: draft.clientId, message: "clé de session différente", retryable: false });
          continue;
        }
        try {
          await send({ ...sanitizeDraftInput(draft.input), clientId: draft.clientId, validate: false });
          await deps.store.delete(draft.clientId);
          result.sent.push(draft.clientId);
        } catch (e) {
          const retryable = e instanceof RetryableError;
          const message = e instanceof Error ? e.message : String(e);
          result.failed.push({ clientId: draft.clientId, message, retryable });
          await deps.store.set(draft.clientId, { ...stored, attempts: stored.attempts + 1, lastError: message });
          if (retryable) break; // le réseau est tombé : on réessaiera plus tard
        }
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Historique local des écritures créées depuis l'appareil (chiffré également)
// ---------------------------------------------------------------------------

export interface RecentEntry {
  id: string;
  journalCode: string;
  date: string;
  label: string;
  status: "DRAFT" | "VALIDATED";
  number: number | null;
  totalDebit: string;
  reversedByEntryId?: string | null;
  updatedAt: string;
}

export const RECENT_LIMIT = 20;

export interface RecentStore {
  list(): Promise<RecentEntry[]>;
  upsert(entry: RecentEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Une seule entrée chiffrée contenant la liste ; la clé est l'id de clé de session. */
export function createRecentStore(deps: { store: KeyValueStore<{ iv: string; data: string }>; cipher: Cipher }): RecentStore {
  const key = `recent:${deps.cipher.keyId}`;
  async function read(): Promise<RecentEntry[]> {
    const blob = await deps.store.get(key);
    if (!blob) return [];
    try {
      return JSON.parse(await deps.cipher.decrypt(blob.iv, blob.data)) as RecentEntry[];
    } catch {
      return [];
    }
  }
  async function write(list: RecentEntry[]) {
    await deps.store.set(key, await deps.cipher.encrypt(JSON.stringify(list.slice(0, RECENT_LIMIT))));
  }
  return {
    list: read,
    async upsert(entry) {
      const list = (await read()).filter((e) => e.id !== entry.id);
      await write([entry, ...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    },
    async remove(id) {
      await write((await read()).filter((e) => e.id !== id));
    },
  };
}
