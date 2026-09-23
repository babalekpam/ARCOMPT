// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
/**
 * Synchronisation : un seul point d'entrée pour vider les deux files
 * (docs/OFFLINE.md).
 *
 * Deux files coexistent volontairement. `queue` est la file historique des
 * brouillons d'écriture ; un appareil resté hors ligne depuis la version
 * précédente en contient peut-être, et les perdre serait perdre la saisie d'un
 * comptable. `operations` est la file généralisée. Elles se vident dans cet
 * ordre — les écritures d'abord, parce qu'elles sont les plus anciennes.
 *
 * L'ordre importe aussi À L'INTÉRIEUR de la file d'opérations : un tiers créé
 * hors ligne doit partir avant la facture qui le désigne. La file trie par date
 * de création, et une dépendance non encore résolue met l'opération en attente
 * plutôt que de l'envoyer avec une référence locale que le serveur ne
 * comprendrait pas.
 */
import { apiClient, ApiError, NetworkError } from "./api-client";
import { toRecentEntry } from "./entries";
import { RetryableError } from "./offline";
import { getOfflineServices } from "./offline-browser";
import { SNAPSHOT_SOURCES, SNAPSHOT_KEYS, type SnapshotContext, type SnapshotKey } from "./offline-snapshot";
import type { OperationKind } from "./offline-queue";
import type { JournalEntry } from "./types";

export interface SyncReport {
  /** Éléments effectivement acceptés par le serveur. */
  sent: number;
  /** Éléments laissés en file faute d'une dépendance locale résolue. */
  waiting: number;
  /** Éléments refusés par le serveur : ils demandent une correction humaine. */
  blocked: Array<{ kind: OperationKind | "entry.draft"; message: string }>;
  /** Vrai si le réseau a lâché en cours de route : le reste part au prochain essai. */
  interrupted: boolean;
}

/** Une erreur réseau ou un 5xx se réessaie ; un refus métier (4xx) non. */
function asRetryable(e: unknown): never {
  if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) throw new RetryableError(e instanceof Error ? e.message : String(e));
  throw e;
}

export async function syncNow(): Promise<SyncReport> {
  const svc = await getOfflineServices();
  const report: SyncReport = { sent: 0, waiting: 0, blocked: [], interrupted: false };
  if (!svc) return report;

  // 1. Brouillons d'écriture (file historique).
  const drafts = await svc.queue.replay(async (body) => {
    try {
      const entry = await apiClient<JournalEntry>("/entries", { method: "POST", body });
      await svc.recent.upsert(toRecentEntry(entry));
      return { id: entry.id };
    } catch (e) {
      return asRetryable(e);
    }
  });
  report.sent += drafts.sent.length;
  for (const f of drafts.failed) {
    if (f.retryable) report.interrupted = true;
    else report.blocked.push({ kind: "entry.draft", message: f.message });
  }

  // 2. File généralisée. Interrompue par une coupure, elle reprendra intacte :
  //    rien n'est supprimé avant d'avoir été accepté.
  if (!report.interrupted) {
    const ops = await svc.operations.replay(async ({ path, body }) => {
      try {
        const created = await apiClient<{ id?: string }>(path, { method: "POST", body });
        return { id: created?.id ?? null };
      } catch (e) {
        return asRetryable(e);
      }
    });
    report.sent += ops.sent.length;
    report.waiting += ops.waiting.length;
    for (const f of ops.failed) {
      if (f.retryable) report.interrupted = true;
      else report.blocked.push({ kind: f.kind, message: f.message });
    }
  }

  return report;
}

/** Jeux de référence rafraîchis à chaque passage en ligne. */
export async function refreshSnapshots(ctx: SnapshotContext, keys: readonly SnapshotKey[] = SNAPSHOT_KEYS): Promise<SnapshotKey[]> {
  const svc = await getOfflineServices();
  if (!svc) return [];
  const refreshed: SnapshotKey[] = [];
  for (const key of keys) {
    try {
      const data = await apiClient<unknown>(SNAPSHOT_SOURCES[key](ctx));
      await svc.snapshots.write(key, data);
      refreshed.push(key);
    } catch {
      // Un jeu indisponible (droit manquant sur ce rôle, module non ouvert au
      // dossier) ne doit pas empêcher les autres : le cliché est partiel, pas absent.
    }
  }
  return refreshed;
}

/** Nombre total d'éléments en attente, pour le bandeau et le centre de synchronisation. */
export async function pendingCount(): Promise<{ total: number; blocked: number }> {
  const svc = await getOfflineServices();
  if (!svc) return { total: 0, blocked: 0 };
  const [drafts, ops, blocked] = await Promise.all([svc.queue.count(), svc.operations.count(), svc.operations.countBlocked()]);
  return { total: drafts + ops, blocked };
}

export const SYNC_EVENT = "arcompt:drafts-changed";

export function notifySyncChanged() {
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}
