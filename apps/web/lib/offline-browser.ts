// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
/**
 * Branche la file de brouillons sur le navigateur : IndexedDB + clé AES-GCM
 * dérivée du matériau de session fourni par `/api/session/offline-key`.
 * Singleton par onglet ; `null` si IndexedDB ou WebCrypto manquent.
 *
 * Démarrage à froid hors ligne : si la clé de session ne peut pas être
 * récupérée (réseau coupé) mais que l'appareil conserve EXACTEMENT la clé de
 * la dernière session ouverte en ligne (repère en localStorage, effacé à la
 * déconnexion), le coffre se rouvre avec cette clé. Sans ce repli, un onglet
 * ouvert hors ligne ne verrait ni la file ni les copies locales, alors même
 * que tout est sur l'appareil. La clé reste liée à l'utilisateur ET au
 * dossier : au retour du réseau, `revalidateOfflineServices` revérifie le
 * matériau de session avant tout envoi — si la session a changé de clé, les
 * services sont reconstruits sur la nouvelle et les éléments chiffrés avec
 * l'ancienne ne sont JAMAIS envoyés sous une autre identité.
 */
import { createDraftQueue, createRecentStore, fromBase64, IndexedDbStore, loadOrCreateCipher, WebCryptoCipher, type DraftQueue, type RecentStore, type StoredDraft } from "./offline";
import { createOperationQueue, type OperationQueue, type StoredOperation } from "./offline-queue";
import { createSnapshotStore, type SnapshotStore, type StoredSnapshot } from "./offline-snapshot";

export interface OfflineServices {
  /** File historique des brouillons d'écriture ; conservée pour ne rien perdre d'un appareil déjà en attente. */
  queue: DraftQueue;
  /** File généralisée : tiers, articles, brouillons de vente et d'achat, mouvements de stock. */
  operations: OperationQueue;
  /** Cliché local des données de référence, pour que les écrans aient de quoi travailler hors ligne. */
  snapshots: SnapshotStore;
  recent: RecentStore;
  keyId: string;
}

/** Repère de la dernière clé ouverte en ligne sur cet appareil. */
const KEY_MARKER = "arcompt.offlineKeyId";

let cached: Promise<OfflineServices | null> | null = null;

export function getOfflineServices(): Promise<OfflineServices | null> {
  cached ??= init().catch((e) => {
    console.warn("Mode hors ligne indisponible :", e);
    cached = null;
    return null;
  });
  return cached;
}

/** À appeler à la déconnexion : oublie la clé en mémoire ET le repère de démarrage à froid. */
export function resetOfflineServices() {
  cached = null;
  try {
    localStorage.removeItem(KEY_MARKER);
  } catch {
    /* stockage indisponible : le repère est un confort, pas une barrière */
  }
}

function buildServices(cipher: WebCryptoCipher): OfflineServices {
  return {
    queue: createDraftQueue({ store: new IndexedDbStore<StoredDraft>("drafts"), cipher }),
    operations: createOperationQueue({
      store: new IndexedDbStore<StoredOperation>("operations"),
      links: new IndexedDbStore<{ iv: string; data: string }>("links"),
      cipher,
    }),
    snapshots: createSnapshotStore({ store: new IndexedDbStore<StoredSnapshot>("snapshot"), cipher }),
    recent: createRecentStore({ store: new IndexedDbStore<{ iv: string; data: string }>("recent"), cipher }),
    keyId: cipher.keyId,
  };
}

function rememberKey(keyId: string) {
  try {
    localStorage.setItem(KEY_MARKER, keyId);
  } catch {
    /* idem resetOfflineServices */
  }
}

/** Récupère le matériau de session et la clé correspondante ; null si le serveur ne répond pas en ligne. */
async function cipherFromServer(keys: IndexedDbStore<CryptoKey>): Promise<WebCryptoCipher | null> {
  const res = await fetch("/api/session/offline-key", { cache: "no-store" });
  if (!res.ok) return null;
  const { material } = (await res.json()) as { material: string };
  return loadOrCreateCipher(keys, fromBase64(material));
}

async function init(): Promise<OfflineServices | null> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) return null;
  const keys = new IndexedDbStore<CryptoKey>("keys");
  try {
    const cipher = await cipherFromServer(keys);
    if (cipher) {
      rememberKey(cipher.keyId);
      return buildServices(cipher);
    }
  } catch {
    /* réseau coupé : repli démarrage à froid ci-dessous */
  }
  // Repli : rouvrir le coffre avec la clé déjà sur l'appareil, uniquement si
  // c'est celle de la dernière session en ligne (repère) et la seule présente.
  try {
    const marker = localStorage.getItem(KEY_MARKER);
    const ids = await keys.keys();
    if (marker && ids.length === 1 && ids[0] === marker) {
      const key = await keys.get(marker);
      if (key) return buildServices(new WebCryptoCipher(key, marker));
    }
  } catch {
    /* coffre illisible : le mode hors ligne reste indisponible pour cet onglet */
  }
  return null;
}

/**
 * À appeler avant tout envoi quand le réseau est là : si la session courante
 * a une autre clé que celle des services en mémoire (démarrage à froid hors
 * ligne, changement de dossier…), reconstruit les services sur la bonne clé.
 * Les éléments de l'ancienne clé restent chiffrés chez elle, jamais réémis.
 */
export async function revalidateOfflineServices(): Promise<void> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) return;
  let cipher: WebCryptoCipher | null = null;
  try {
    cipher = await cipherFromServer(new IndexedDbStore<CryptoKey>("keys"));
  } catch {
    return; // toujours hors ligne : on garde les services courants
  }
  if (!cipher) return;
  rememberKey(cipher.keyId);
  const current = cached ? await cached.catch(() => null) : null;
  if (current && current.keyId === cipher.keyId) return;
  cached = Promise.resolve(buildServices(cipher));
}
