/**
 * Cliché local des données de référence (docs/OFFLINE.md).
 *
 * Une file d'envoi ne suffit pas à travailler hors ligne. Pour saisir une
 * facture il faut la liste des clients ; pour saisir une écriture, le plan de
 * comptes et les journaux ; pour un mouvement de stock, les articles. Sans
 * elles, l'écran est vide et la file n'a rien à recevoir.
 *
 * Le cliché est donc la moitié LECTURE du mode hors ligne : chaque passage en
 * ligne rafraîchit un petit nombre de jeux de référence, et la coupure suivante
 * les retrouve. Ce que le cliché ne fait PAS, et ne doit pas faire :
 *
 *   - il ne conserve ni grand livre, ni balance, ni états financiers. Ces
 *     documents se calculent sur un arrêté à un instant donné ; en servir une
 *     copie vieille de trois jours sans le dire ferait prendre une décision sur
 *     des chiffres faux. L'écran concerné annonce la coupure et n'invente rien.
 *   - il ne conserve aucune donnée de paie, aucun identifiant fiscal. Un
 *     appareil perdu ne doit pas les emporter, même chiffrés.
 *   - il ne remplace jamais une réponse fraîche : tant que le réseau répond,
 *     c'est le réseau qui gagne, et le cliché n'est que mis à jour.
 *
 * Chaque jeu est chiffré avec la clé de session, comme la file. L'âge est
 * conservé en clair : c'est lui qui permet d'afficher « données du 12 mars »
 * plutôt que de laisser croire à de l'actuel.
 */
import type { Cipher, KeyValueStore } from "./offline";

/** Jeux de référence conservés. Ajouter ici, pas ailleurs : la liste est la politique. */
export const SNAPSHOT_KEYS = ["accounts", "partners", "products", "stockArticles", "fiscalYears", "pack"] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

/**
 * Contexte nécessaire pour construire les chemins. Le pack pays porte les
 * journaux, les codes de TVA et les comptes imposés par le référentiel : c'est
 * lui qu'il faut conserver, pas six listes dérivées.
 */
export interface SnapshotContext {
  /** Code du pack du dossier courant (« ci », « tg »…). */
  packCode: string;
}

/** Chemins API rafraîchis, dans l'ordre où ils sont demandés. */
export const SNAPSHOT_SOURCES: Record<SnapshotKey, (ctx: SnapshotContext) => string> = {
  accounts: () => "/accounts",
  partners: () => "/partners",
  products: () => "/products",
  stockArticles: () => "/stock/articles",
  fiscalYears: () => "/entries/fiscal-years",
  pack: (ctx) => `/packs/${encodeURIComponent(ctx.packCode)}`,
};

export interface StoredSnapshot {
  key: SnapshotKey;
  /** Horodatage du rafraîchissement, en clair : c'est ce que l'écran affiche. */
  fetchedAt: string;
  keyId: string;
  iv: string;
  data: string;
}

export interface Snapshot<T = unknown> {
  key: SnapshotKey;
  fetchedAt: string;
  data: T;
  /** Âge en millisecondes au moment de la lecture. */
  ageMs: number;
}

/** Au-delà, l'écran dit « données du … » au lieu de les présenter comme à jour. */
export const SNAPSHOT_STALE_MS = 6 * 60 * 60 * 1000;

export interface SnapshotStore {
  read<T>(key: SnapshotKey): Promise<Snapshot<T> | null>;
  write(key: SnapshotKey, data: unknown): Promise<void>;
  /** Âge de chaque jeu conservé, pour le centre de synchronisation. */
  ages(): Promise<Array<{ key: SnapshotKey; fetchedAt: string; ageMs: number }>>;
  clear(): Promise<void>;
}

export function createSnapshotStore(deps: { store: KeyValueStore<StoredSnapshot>; cipher: Cipher; now?: () => Date }): SnapshotStore {
  const now = deps.now ?? (() => new Date());

  return {
    async read<T>(key: SnapshotKey) {
      const stored = await deps.store.get(key);
      if (!stored || stored.keyId !== deps.cipher.keyId) return null;
      try {
        const data = JSON.parse(await deps.cipher.decrypt(stored.iv, stored.data)) as T;
        return { key, fetchedAt: stored.fetchedAt, data, ageMs: now().getTime() - new Date(stored.fetchedAt).getTime() };
      } catch {
        // Clé changée ou enregistrement corrompu : on ne devine pas, on ne rend rien.
        return null;
      }
    },

    async write(key, data) {
      const { iv, data: payload } = await deps.cipher.encrypt(JSON.stringify(data));
      await deps.store.set(key, { key, fetchedAt: now().toISOString(), keyId: deps.cipher.keyId, iv, data: payload });
    },

    async ages() {
      const out: Array<{ key: SnapshotKey; fetchedAt: string; ageMs: number }> = [];
      for (const k of await deps.store.keys()) {
        const stored = await deps.store.get(k);
        if (stored) out.push({ key: stored.key, fetchedAt: stored.fetchedAt, ageMs: now().getTime() - new Date(stored.fetchedAt).getTime() });
      }
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },

    async clear() {
      for (const k of await deps.store.keys()) await deps.store.delete(k);
    },
  };
}

export interface CachedResult<T> {
  data: T;
  /** Vrai quand la donnée vient du cliché : le réseau n'a pas répondu. */
  fromSnapshot: boolean;
  fetchedAt: string;
  stale: boolean;
}

/**
 * Lecture « réseau d'abord, cliché en repli ». Le repli n'est jamais silencieux :
 * l'appelant reçoit `fromSnapshot` et la date, et l'écran le dit.
 *
 * Une absence totale (jamais rafraîchi) remonte l'erreur réseau : mieux vaut un
 * écran qui explique la coupure qu'un écran vide qui laisse croire qu'il n'y a
 * pas de clients.
 */
export async function readWithSnapshot<T>(
  key: SnapshotKey,
  fetcher: () => Promise<T>,
  snapshots: SnapshotStore,
  opts: { now?: () => Date } = {},
): Promise<CachedResult<T>> {
  const now = opts.now ?? (() => new Date());
  try {
    const data = await fetcher();
    await snapshots.write(key, data).catch(() => undefined); // un cliché non écrit ne doit pas faire échouer une lecture réussie
    return { data, fromSnapshot: false, fetchedAt: now().toISOString(), stale: false };
  } catch (networkError) {
    const cached = await snapshots.read<T>(key);
    if (!cached) throw networkError;
    return { data: cached.data, fromSnapshot: true, fetchedAt: cached.fetchedAt, stale: cached.ageMs > SNAPSHOT_STALE_MS };
  }
}
