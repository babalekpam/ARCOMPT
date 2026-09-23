// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { checklistProgress, checklistTone, evidenceNote } from "./helpers";
import type { ChecklistItem, ChecklistStatus } from "./types";

/**
 * Liste de contrôle (mensuelle ou annuelle) : cocher / décocher / N/A avec
 * note de preuve. Vide → bouton de génération (idempotent côté API).
 */
export function Checklist({ fiscalYear, periodId, initialItems, embedded = false }: { fiscalYear: string; periodId?: string; initialItems: ChecklistItem[] | null; embedded?: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [items, setItems] = useState<ChecklistItem[] | null>(initialItems);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setItems(initialItems), [initialItems]);

  const query = { fiscalYear, ...(periodId ? { period: periodId } : {}) };

  const generate = async () => {
    setBusy("generate");
    setError(null);
    try {
      setItems(await apiClient<ChecklistItem[]>("/closing/checklist", { method: "POST", body: query }));
      if (!embedded) router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const tick = async (item: ChecklistItem, status: ChecklistStatus) => {
    setBusy(item.id);
    setError(null);
    try {
      const note = (notes[item.id] ?? evidenceNote(item.evidence)).trim();
      const updated = await apiClient<ChecklistItem>(`/closing/checklist/${item.id}/tick`, { method: "POST", body: { status, ...(note ? { evidence: { ...item.evidence, note } } : {}) } });
      setItems((list) => (list ?? []).map((i) => (i.id === item.id ? updated : i)));
      if (!embedded) router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const progress = checklistProgress(items ?? []);

  return (
    <div className="space-y-3">
      {items && items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>{t("closing.checklist.progress", { done: progress.done, total: progress.total })}</span>
          {progress.blockingTodo > 0 ? <Badge tone="danger">{t("closing.checklist.blockingTodo", { count: progress.blockingTodo })}</Badge> : <Badge tone="success">{t("closing.checklist.ready")}</Badge>}
        </div>
      ) : null}
      {items === null || items.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-500">{t("closing.checklist.none")}</span>
          <Button size="sm" variant="secondary" onClick={() => void generate()} disabled={busy !== null}>
            {busy === "generate" ? t("common.loading") : t("closing.checklist.generate")}
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-start">
              <label className="flex flex-1 items-start gap-2">
                <input type="checkbox" className="mt-1" checked={item.status === "DONE"} disabled={busy !== null} onChange={(e) => void tick(item, e.target.checked ? "DONE" : "TODO")} aria-label={item.label} />
                <span>
                  <span className={item.status === "NA" ? "text-slate-400 line-through" : ""}>{item.label}</span>
                  <span className="ml-2 inline-flex gap-1">
                    {item.blocking ? <Badge tone="danger">{t("closing.checklist.blocking")}</Badge> : null}
                    <Badge tone={checklistTone(item.status)}>{t(`closing.checklistStatus.${item.status}`)}</Badge>
                  </span>
                  {item.doneAt ? (
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {formatDate(locale, item.doneAt)} · <span className="font-mono">{item.doneBy}</span>
                    </span>
                  ) : null}
                </span>
              </label>
              <div className="flex items-center gap-1 sm:w-72">
                <Input value={notes[item.id] ?? evidenceNote(item.evidence)} onChange={(e) => setNotes((n) => ({ ...n, [item.id]: e.target.value }))} placeholder={t("closing.checklist.evidence")} className="text-xs" maxLength={500} disabled={busy !== null} />
                {item.status !== "NA" ? (
                  <Button size="sm" variant="ghost" onClick={() => void tick(item, "NA")} disabled={busy !== null} title={t("closing.checklist.markNa")}>
                    N/A
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void tick(item, "TODO")} disabled={busy !== null}>
                    ↺
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
