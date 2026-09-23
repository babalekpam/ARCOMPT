/**
 * File d'opérations hors ligne (docs/OFFLINE.md).
 *
 * `offline.ts` ne mettait en file qu'une chose : un brouillon d'écriture. Sur le
 * terrain, la saisie qui manque au réseau est plus large — on crée un client,
 * un article, un brouillon de facture, un mouvement de stock, et on photographie
 * les pièces. Cette file transporte toutes ces créations, avec trois propriétés
 * que la file de brouillons n'avait pas à porter :
 *
 * 1. **Typage de l'opération.** Chaque élément sait vers quelle route il part et
 *    quel objet il crée. Le rejeu n'est plus un envoi unique mais une séquence.
 *
 * 2. **Dépendances locales.** Une facture saisie hors ligne peut viser un client
 *    créé hors ligne la minute d'avant : il n'a pas encore d'identifiant
 *    serveur. L'appareil lui en attribue un LOCAL (`local:<uuid>`) et le rejeu
 *    substitue l'identifiant serveur une fois le client réellement créé. Une
 *    dépendance non résolue met l'opération EN ATTENTE ; elle n'est jamais
 *    envoyée avec une référence inventée.
 *
 * 3. **Idempotence de bout en bout.** Le `clientId` de chaque élément part dans
 *    le corps ; l'API le conserve (`idempotency_record`) et rend la même réponse
 *    à un second envoi. Un réseau qui coupe après l'écriture serveur mais avant
 *    la réponse ne crée donc pas de doublon.
 *
 * Le contenu reste chiffré au repos, comme la file de brouillons : AES-GCM avec
 * la clé de session non extractable.
 */
import { generateClientId, RetryableError, type Cipher, type KeyValueStore } from "./offline";

/** Opérations que la file sait rejouer. Aucune n'est un acte à numéro légal. */
export const OPERATION_KINDS = [
  "entry.draft",
  "partner.create",
  "product.create",
  "sales.draft",
  "purchase.draft",
  "stock.article",
  "stock.movement",
  "stock.count",
  "document.upload",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** Route et objet créé, par type d'opération. */
export const OPERATION_ROUTES: Record<OperationKind, { path: string; label: string }> = {
  "entry.draft": { path: "/entries", label: "Écriture (brouillon)" },
  "partner.create": { path: "/partners", label: "Tiers" },
  "product.create": { path: "/products", label: "Produit" },
  "sales.draft": { path: "/sales", label: "Vente (brouillon)" },
  "purchase.draft": { path: "/purchases", label: "Achat (brouillon)" },
  "stock.article": { path: "/stock/articles", label: "Article de stock" },
  "stock.movement": { path: "/stock/movements", label: "Mouvement de stock" },
  "stock.count": { path: "/stock/counts", label: "Inventaire physique" },
  "document.upload": { path: "/documents", label: "Pièce justificative" },
};

export const LOCAL_ID_PREFIX = "local:";

/** Identifiant provisoire attribué sur l'appareil à un objet pas encore créé côté serveur. */
export function localId(clientId = generateClientId()): string {
  return `${LOCAL_ID_PREFIX}${clientId}`;
}

export function isLocalId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(LOCAL_ID_PREFIX);
}

export interface StoredOperation {
  clientId: string;
  kind: OperationKind;
  createdAt: string;
  keyId: string;
  iv: string;
  data: string;
  /** Identifiant local de l'objet créé par cette opération, s'il est référencé ailleurs. */
  produces?: string;
  attempts: number;
  lastError?: string;
  /** Vrai quand l'échec vient d'une dépendance non résolue, pas d'un refus serveur. */
  waiting?: boolean;
}

export interface QueuedOperation {
  clientId: string;
  kind: OperationKind;
  createdAt: string;
  /** Absent si la clé de session a changé : le contenu n'est plus déchiffrable. */
  input?: Record<string, unknown>;
  produces?: string;
  attempts: number;
  lastError?: string;
  waiting?: boolean;
}

export interface OperationReplayResult {
  sent: string[];
  /** Opérations laissées en file faute de dépendance résolue. */
  waiting: string[];
  failed: Array<{ clientId: string; kind: OperationKind; message: string; retryable: boolean }>;
}

export class UnresolvedDependencyError extends Error {
  override name = "UnresolvedDependencyError";
  constructor(readonly reference: string) {
    super(`Dépendance locale non résolue : ${reference}`);
  }
}

/** Réponse attendue d'un envoi : l'identifiant serveur, quand l'objet en a un. */
export interface SendOutcome {
  id?: string | null;
}

export interface OperationQueue {
  enqueue(kind: OperationKind, input: Record<string, unknown>, opts?: { clientId?: string; produces?: string }): Promise<QueuedOperation>;
  list(): Promise<QueuedOperation[]>;
  count(): Promise<number>;
  /** Nombre d'opérations bloquées par un refus serveur (à traiter à la main). */
  countBlocked(): Promise<number>;
  remove(clientId: string): Promise<void>;
  /** Oublie l'erreur conservée pour qu'un prochain rejeu la retente. */
  retry(clientId: string): Promise<void>;
  replay(send: (op: { kind: OperationKind; path: string; body: Record<string, unknown> }) => Promise<SendOutcome | void>): Promise<OperationReplayResult>;
  /** Table des identifiants locaux déjà résolus (diagnostic et affichage). */
  resolved(): Promise<Record<string, string>>;
}

/**
 * Remplace récursivement tout `local:<uuid>` par son identifiant serveur.
 * Une référence inconnue lève : l'opération est mise en attente plutôt
 * qu'envoyée avec une référence que le serveur rejetterait — ou pire,
 * accepterait comme du texte libre.
 */
export function resolveLocalRefs<T>(value: T, table: Record<string, string>): T {
  if (isLocalId(value)) {
    const target = table[value];
    if (!target) throw new UnresolvedDependencyError(value);
    return target as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveLocalRefs(v, table)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveLocalRefs(v, table);
    return out as unknown as T;
  }
  return value;
}

/** Liste les références locales présentes dans un corps (pour l'affichage « en attente de … »). */
export function collectLocalRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (isLocalId(value)) into.add(value);
  else if (Array.isArray(value)) for (const v of value) collectLocalRefs(v, into);
  else if (value && typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) collectLocalRefs(v, into);
  return into;
}

export interface OperationQueueDeps {
  store: KeyValueStore<StoredOperation>;
  /** Table `local:<uuid>` → identifiant serveur, chiffrée elle aussi. */
  links: KeyValueStore<{ iv: string; data: string }>;
  cipher: Cipher;
  now?: () => Date;
}

export function createOperationQueue(deps: OperationQueueDeps): OperationQueue {
  const now = deps.now ?? (() => new Date());
  const linksKey = `links:${deps.cipher.keyId}`;

  async function readLinks(): Promise<Record<string, string>> {
    const blob = await deps.links.get(linksKey);
    if (!blob) return {};
    try {
      return JSON.parse(await deps.cipher.decrypt(blob.iv, blob.data)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async function writeLinks(table: Record<string, string>) {
    await deps.links.set(linksKey, await deps.cipher.encrypt(JSON.stringify(table)));
  }

  async function readAll(): Promise<StoredOperation[]> {
    const out: StoredOperation[] = [];
    for (const k of await deps.store.keys()) {
      const op = await deps.store.get(k);
      if (op) out.push(op);
    }
    // L'ordre de création est l'ordre de dépendance : le tiers créé avant la
    // facture est rejoué avant elle.
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.clientId.localeCompare(b.clientId));
  }

  function open(op: StoredOperation): Promise<QueuedOperation> {
    const base: QueuedOperation = {
      clientId: op.clientId,
      kind: op.kind,
      createdAt: op.createdAt,
      attempts: op.attempts,
      ...(op.produces ? { produces: op.produces } : {}),
      ...(op.lastError ? { lastError: op.lastError } : {}),
      ...(op.waiting ? { waiting: op.waiting } : {}),
    };
    if (op.keyId !== deps.cipher.keyId) return Promise.resolve(base);
    return deps.cipher
      .decrypt(op.iv, op.data)
      .then((plain) => ({ ...base, input: JSON.parse(plain) as Record<string, unknown> }))
      .catch(() => base);
  }

  return {
    async enqueue(kind, input, opts = {}) {
      const clientId = opts.clientId ?? generateClientId();
      const { iv, data } = await deps.cipher.encrypt(JSON.stringify(input));
      const stored: StoredOperation = {
        clientId,
        kind,
        createdAt: now().toISOString(),
        keyId: deps.cipher.keyId,
        iv,
        data,
        attempts: 0,
        ...(opts.produces ? { produces: opts.produces } : {}),
      };
      await deps.store.set(clientId, stored);
      return { clientId, kind, createdAt: stored.createdAt, input, attempts: 0, ...(opts.produces ? { produces: opts.produces } : {}) };
    },

    async list() {
      return Promise.all((await readAll()).map(open));
    },

    async count() {
      return (await deps.store.keys()).length;
    },

    async countBlocked() {
      return (await readAll()).filter((o) => o.lastError && !o.waiting).length;
    },

    async remove(clientId) {
      await deps.store.delete(clientId);
    },

    async retry(clientId) {
      const op = await deps.store.get(clientId);
      if (!op) return;
      // Retirer les champs plutôt que les mettre à undefined : `exactOptionalPropertyTypes`
      // distingue « absent » de « présent et undefined », et le store est cloné tel quel.
      const rest: StoredOperation = { ...op };
      delete rest.lastError;
      delete rest.waiting;
      await deps.store.set(clientId, rest);
    },

    async resolved() {
      return readLinks();
    },

    async replay(send) {
      const result: OperationReplayResult = { sent: [], waiting: [], failed: [] };
      const table = await readLinks();
      let linksChanged = false;

      for (const stored of await readAll()) {
        const op = await open(stored);
        if (!op.input) {
          result.failed.push({ clientId: op.clientId, kind: op.kind, message: "clé de session différente", retryable: false });
          continue;
        }

        let body: Record<string, unknown>;
        try {
          body = resolveLocalRefs(op.input, table);
        } catch (e) {
          if (e instanceof UnresolvedDependencyError) {
            // La dépendance est peut-être plus loin dans la file (elle ne devrait
            // pas l'être) ou elle a échoué : on garde l'opération, on n'invente rien.
            result.waiting.push(op.clientId);
            await deps.store.set(op.clientId, { ...stored, waiting: true, lastError: e.message });
            continue;
          }
          throw e;
        }

        try {
          const outcome = await send({ kind: op.kind, path: OPERATION_ROUTES[op.kind].path, body: { ...body, clientId: op.clientId } });
          if (op.produces && outcome && typeof outcome.id === "string") {
            table[op.produces] = outcome.id;
            linksChanged = true;
          }
          await deps.store.delete(op.clientId);
          result.sent.push(op.clientId);
        } catch (e) {
          const retryable = e instanceof RetryableError;
          const message = e instanceof Error ? e.message : String(e);
          result.failed.push({ clientId: op.clientId, kind: op.kind, message, retryable });
          await deps.store.set(op.clientId, { ...stored, attempts: stored.attempts + 1, lastError: message });
          if (retryable) break; // le réseau est retombé : la suite attendra
        }
      }

      if (linksChanged) await writeLinks(table);
      return result;
    },
  };
}
