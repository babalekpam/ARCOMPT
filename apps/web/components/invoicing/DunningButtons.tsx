"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input, Select } from "@/components/ui/Field";
import type { Dunning, DunningChannel, OverdueInvoice } from "./types";
import { DUNNING_CHANNELS } from "./types";

/** Boutons de relance d'une facture échue : niveaux 1 à 3 (le niveau suggéré en premier), canal et message facultatif. */
export function DunningButtons({ row }: { row: OverdueInvoice }) {
  const t = useT();
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(null);
  const [channel, setChannel] = useState<DunningChannel>(typeof row.partnerContact.phone === "string" ? "WHATSAPP" : "EMAIL");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = async () => {
    if (level === null) return;
    setBusy(true);
    setError(null);
    try {
      const d = await apiClient<Dunning>(`/sales/${row.documentId}/dunning`, { method: "POST", body: { level, channel, ...(message.trim() ? { message: message.trim() } : {}) } });
      setDone(t("invoicing.actions.dunningRecorded", { level: d.level, channel: t(`invoicing.channel.${d.channel}`) }));
      setLevel(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {[1, 2, 3].map((n) => (
        <Button key={n} size="sm" variant={n === row.suggestedLevel ? "primary" : "secondary"} onClick={() => setLevel(n)} disabled={n <= row.lastDunningLevel}>
          {t("invoicing.dunning.levelN", { n })}
        </Button>
      ))}
      {done ? <span className="basis-full text-xs text-emerald-700 dark:text-emerald-300">{done}</span> : null}
      {error ? <span className="basis-full text-xs text-red-600">{error}</span> : null}
      <ConfirmDialog
        open={level !== null}
        title={t("invoicing.dunning.levelN", { n: level ?? 0 })}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => {
          if (!busy) setLevel(null);
        }}
      >
        <p>
          {row.number} · {row.partnerName} · {t("invoicing.dunning.daysOverdue", { days: row.daysOverdue })}
        </p>
        <div className="mt-2 space-y-2">
          <Field label={t("invoicing.dunning.channel")}>
            <Select value={channel} onChange={(e) => setChannel(e.target.value as DunningChannel)}>
              {DUNNING_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`invoicing.channel.${c}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`${t("invoicing.dunning.message")} (${t("common.optional")})`}>
            <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}
