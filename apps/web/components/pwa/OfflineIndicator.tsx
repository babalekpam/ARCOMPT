"use client";
import { useCallback, useEffect, useState } from "react";
import { apiClient, ApiError, NetworkError } from "@/lib/api-client";
import { toRecentEntry } from "@/lib/entries";
import { useT } from "@/lib/i18n-client";
import { RetryableError } from "@/lib/offline";
import { getOfflineServices } from "@/lib/offline-browser";
import type { JournalEntry } from "@/lib/types";

/**
 * Bandeau hors ligne + file de brouillons : affiche l'état réseau, le nombre
 * de brouillons en attente et rejoue la file au retour du réseau (ou à la demande).
 * Ne rejoue que des créations de brouillons (validate: false), jamais de validation.
 */
export function OfflineIndicator() {
  const t = useT();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshCount = useCallback(async () => {
    const svc = await getOfflineServices();
    setPending(svc ? await svc.queue.count() : 0);
  }, []);

  const sync = useCallback(async () => {
    const svc = await getOfflineServices();
    if (!svc || syncing) return;
    setSyncing(true);
    try {
      const result = await svc.queue.replay(async (body) => {
        try {
          const entry = await apiClient<JournalEntry>("/entries", { method: "POST", body });
          await svc.recent.upsert(toRecentEntry(entry));
          return { id: entry.id };
        } catch (e) {
          if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) throw new RetryableError(e.message);
          throw e;
        }
      });
      if (result.sent.length > 0 && result.failed.length === 0) setMessage({ tone: "ok", text: t("offline.synced") });
      else if (result.failed.length > 0) setMessage({ tone: "error", text: t("offline.syncError", { message: result.failed[0]!.message }) });
      window.dispatchEvent(new CustomEvent("arcompt:drafts-changed"));
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
    window.addEventListener("arcompt:drafts-changed", changed);
    void refreshCount().then(() => {
      if (navigator.onLine) void sync();
    });
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("arcompt:drafts-changed", changed);
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
        {pending > 0 ? <span className="ml-2 font-medium">{t("offline.pending", { count: pending })}</span> : null}
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
