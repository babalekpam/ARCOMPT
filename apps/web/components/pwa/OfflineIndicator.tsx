// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n-client";
import { getOfflineServices } from "@/lib/offline-browser";
import { notifySyncChanged, pendingCount, refreshSnapshots, syncNow, SYNC_EVENT } from "@/lib/offline-sync";

/**
 * Bandeau hors ligne : état réseau, nombre d'éléments en attente, rejeu au
 * retour du réseau ou à la demande.
 *
 * Le rejeu lui-même vit dans `lib/offline-sync.ts` : le bandeau ne sait pas ce
 * qu'il envoie, et le centre de synchronisation (/sync) appelle exactement le
 * même code. Deux chemins de rejeu auraient fini par diverger.
 *
 * Ce qui est REFUSÉ par le serveur est signalé séparément : ce n'est pas une
 * attente, c'est une saisie à corriger, et elle ne partira jamais toute seule.
 */
export function OfflineIndicator() {
  const t = useT();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [blocked, setBlocked] = useState(0);

  const refreshCount = useCallback(async () => {
    const { total, blocked: refused } = await pendingCount();
    setPending(total);
    setBlocked(refused);
  }, []);

  const sync = useCallback(async () => {
    const svc = await getOfflineServices();
    if (!svc || syncing) return;
    setSyncing(true);
    try {
      const report = await syncNow();
      if (report.blocked.length > 0) setMessage({ tone: "error", text: t("offline.syncError", { message: report.blocked[0]!.message }) });
      else if (report.sent > 0) setMessage({ tone: "ok", text: t("offline.synced") });
      // Le réseau vient de répondre : on en profite pour rafraîchir le cliché
      // de référence, sans quoi la coupure suivante travaillerait sur des
      // listes vieillissantes. Le code du pack vient du cliché lui-même.
      const pack = await svc.snapshots.read<{ code?: string }>("pack");
      if (pack?.data?.code) void refreshSnapshots({ packCode: pack.data.code });
      notifySyncChanged();
    } finally {
      setSyncing(false);
      await refreshCount();
    }
  }, [refreshCount, syncing, t]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => {
      setOnline(true);
      void sync();
    };
    const goOffline = () => setOnline(false);
    const changed = () => void refreshCount();
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener(SYNC_EVENT, changed);
    void refreshCount().then(() => {
      if (navigator.onLine) void sync();
    });
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener(SYNC_EVENT, changed);
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(id);
  }, [message]);

  if (online && pending === 0 && !message) return null;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs ${online ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "bg-slate-800 text-white"}`} role="status">
      <span>
        {!online ? t("offline.banner") : null}
        {pending > 0 ? (
          <Link href="/sync" className="ml-2 font-medium underline underline-offset-2">
            {t("offline.pending", { count: pending })}
          </Link>
        ) : null}
        {blocked > 0 ? (
          <Link href="/sync" className="ml-2 font-medium text-red-700 underline underline-offset-2 dark:text-red-300">
            {t("offline.center.blocked")} ({blocked})
          </Link>
        ) : null}
        {message ? <span className={`ml-2 ${message.tone === "error" ? "text-red-600 dark:text-red-300" : ""}`}>{message.text}</span> : null}
      </span>
      {online && pending > 0 ? (
        <button type="button" onClick={() => void sync()} disabled={syncing} className="rounded border border-current px-2 py-0.5">
          {syncing ? t("common.loading") : t("offline.syncNow")}
        </button>
      ) : null}
    </div>
  );
}
