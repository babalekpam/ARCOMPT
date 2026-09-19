"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-client";
import type { QueuedDraft, RecentEntry } from "@/lib/offline";
import { getOfflineServices } from "@/lib/offline-browser";
import { StatusBadge } from "@/components/ui/Badge";
import { Money } from "@/components/ui/Money";
import { EntryActionButtons } from "@/components/entries/EntryActionButtons";

/**
 * Écritures récentes de l'appareil : brouillons hors ligne en attente puis
 * écritures créées (historique local chiffré). L'API n'expose pas encore la
 * liste des écritures ; ce panneau sera remplacé par `GET /v1/entries`.
 */
export function RecentEntries({ currency, limit, withActions = false }: { currency: string; limit?: number; withActions?: boolean }) {
  const { t, locale } = useI18n();
  const [recent, setRecent] = useState<RecentEntry[] | null>(null);
  const [queued, setQueued] = useState<QueuedDraft[]>([]);

  const load = async () => {
    const svc = await getOfflineServices();
    if (!svc) return setRecent([]);
    const [r, q] = await Promise.all([svc.recent.list(), svc.queue.list()]);
    setRecent(r);
    setQueued(q);
  };
  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener("arcompt:drafts-changed", handler);
    return () => window.removeEventListener("arcompt:drafts-changed", handler);
  }, []);

  if (recent === null) return <p className="text-xs text-slate-500">{t("common.loading")}</p>;
  const rows = limit ? recent.slice(0, limit) : recent;
  if (rows.length === 0 && queued.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        {t("dashboard.noEntries")}{" "}
        <Link href="/entries/new" className="underline">
          {t("dashboard.newEntry")}
        </Link>
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {queued.map((d) => (
        <li key={d.clientId} className="flex items-center justify-between gap-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate font-medium">{d.input?.label ?? "…"}</div>
            <div className="text-xs text-slate-500">
              {d.input ? `${d.input.journalCode} · ${formatDate(locale, d.input.date)}` : ""}
              {d.lastError ? <span className="ml-2 text-red-600">{d.lastError}</span> : null}
            </div>
          </div>
          <StatusBadge status="QUEUED" label={t("status.QUEUED")} />
        </li>
      ))}
      {rows.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{e.label}</div>
            <div className="text-xs text-slate-500">
              {e.journalCode}
              {e.number ? ` n° ${e.number}` : ""} · {formatDate(locale, e.date)} · <span className="font-mono">{e.id.slice(0, 8)}</span>
            </div>
          </div>
          <Money value={e.totalDebit} currency={currency} className="text-sm" />
          {e.reversedByEntryId ? <StatusBadge status="REVERSED" label={t("status.REVERSED")} /> : <StatusBadge status={e.status} label={t(`status.${e.status}`)} />}
          {withActions ? <EntryActionButtons id={e.id} status={e.status} reversed={Boolean(e.reversedByEntryId)} /> : null}
        </li>
      ))}
    </ul>
  );
}
