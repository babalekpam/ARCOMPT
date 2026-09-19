"use client";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { toRecentEntry } from "@/lib/entries";
import { useT } from "@/lib/i18n-client";
import { getOfflineServices } from "@/lib/offline-browser";
import type { JournalEntry } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";

type Action = "validate" | "reverse" | "discard";

/**
 * Valider / contrepasser / écarter une écriture, avec confirmation. Ces actions
 * exigent le réseau : rien n'est mis en file hors ligne (SECURITY §11).
 */
export function EntryActionButtons({ id, status, reversed = false, onDone }: { id: string; status?: "DRAFT" | "VALIDATED"; reversed?: boolean; onDone?: (message: string) => void }) {
  const t = useT();
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reverseDate, setReverseDate] = useState(new Date().toISOString().slice(0, 10));
  const [reverseLabel, setReverseLabel] = useState("");

  const notify = async (message: string) => {
    window.dispatchEvent(new CustomEvent("arcompt:drafts-changed"));
    onDone?.(message);
  };

  const run = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const svc = await getOfflineServices();
      if (action === "validate") {
        const entry = await apiClient<JournalEntry>(`/entries/${id}/validate`, { method: "POST" });
        await svc?.recent.upsert(toRecentEntry(entry));
        await notify(t("entries.validated", { number: entry.number ?? "?" }));
      } else if (action === "reverse") {
        const entry = await apiClient<JournalEntry>(`/entries/${id}/reverse`, { method: "POST", body: { date: reverseDate, ...(reverseLabel ? { label: reverseLabel } : {}) } });
        await svc?.recent.upsert(toRecentEntry(entry));
        const original = (await svc?.recent.list())?.find((e) => e.id === id);
        if (original && svc) await svc.recent.upsert({ ...original, reversedByEntryId: entry.id, updatedAt: new Date().toISOString() });
        await notify(t("entries.reversed", { number: entry.number ?? "?" }));
      } else {
        await apiClient<void>(`/entries/${id}`, { method: "DELETE" });
        await svc?.recent.remove(id);
        await notify(t("entries.discarded"));
      }
      setAction(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canValidate = status !== "VALIDATED";
  const canReverse = status !== "DRAFT" && !reversed;
  const canDiscard = status !== "VALIDATED";
  return (
    <div className="flex flex-wrap items-center gap-1">
      {canValidate ? (
        <Button size="sm" onClick={() => setAction("validate")}>
          {t("entries.validate")}
        </Button>
      ) : null}
      {canReverse ? (
        <Button size="sm" variant="secondary" onClick={() => setAction("reverse")}>
          {t("entries.reverse")}
        </Button>
      ) : null}
      {canDiscard ? (
        <Button size="sm" variant="danger" onClick={() => setAction("discard")}>
          {t("entries.discard")}
        </Button>
      ) : null}
      {error ? <span className="basis-full text-xs text-red-600">{error}</span> : null}
      <ConfirmDialog
        open={action !== null}
        title={action === "validate" ? t("entries.validate") : action === "reverse" ? t("entries.reverse") : t("entries.discard")}
        confirmVariant={action === "discard" ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => {
          if (!busy) setAction(null);
        }}
      >
        {action === "validate" ? t("entries.validateConfirm") : action === "reverse" ? t("entries.reverseConfirm") : t("entries.discardConfirm")}
        {action === "reverse" ? (
          <div className="mt-3 space-y-2">
            <label className="block text-xs">
              {t("entries.reverseDate")}
              <Input type="date" value={reverseDate} onChange={(e) => setReverseDate(e.target.value)} className="mt-1" />
            </label>
            <label className="block text-xs">
              {t("entries.reverseLabel")} ({t("common.optional")})
              <Input value={reverseLabel} onChange={(e) => setReverseLabel(e.target.value)} className="mt-1" />
            </label>
          </div>
        ) : null}
        <p className="mt-2 font-mono text-[11px] text-slate-400">{id}</p>
      </ConfirmDialog>
    </div>
  );
}
