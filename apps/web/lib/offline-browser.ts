"use client";
/**
 * Branche la file de brouillons sur le navigateur : IndexedDB + clé AES-GCM
 * dérivée du matériau de session fourni par `/api/session/offline-key`.
 * Singleton par onglet ; `null` si IndexedDB ou WebCrypto manquent.
 */
import { createDraftQueue, createRecentStore, fromBase64, IndexedDbStore, loadOrCreateCipher, type DraftQueue, type RecentStore, type StoredDraft } from "./offline";

export interface OfflineServices {
  queue: DraftQueue;
  recent: RecentStore;
  keyId: string;
}

let cached: Promise<OfflineServices | null> | null = null;

export function getOfflineServices(): Promise<OfflineServices | null> {
  cached ??= init().catch((e) => {
    console.warn("Mode hors ligne indisponible :", e);
    cached = null;
    return null;
  });
  return cached;
}

/** À appeler à la déconnexion : oublie la clé en mémoire (la clé IndexedDB sera remplacée à la prochaine session). */
export function resetOfflineServices() {
  cached = null;
}

async function init(): Promise<OfflineServices | null> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) return null;
  const res = await fetch("/api/session/offline-key", { cache: "no-store" });
  if (!res.ok) return null;
  const { material } = (await res.json()) as { material: string };
  const cipher = await loadOrCreateCipher(new IndexedDbStore<CryptoKey>("keys"), fromBase64(material));
  return {
    queue: createDraftQueue({ store: new IndexedDbStore<StoredDraft>("drafts"), cipher }),
    recent: createRecentStore({ store: new IndexedDbStore<{ iv: string; data: string }>("recent"), cipher }),
    keyId: cipher.keyId,
  };
}
