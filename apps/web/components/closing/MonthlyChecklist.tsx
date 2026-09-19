"use client";
import { useEffect, useState } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Alert } from "@/components/ui/Alert";
import { Select } from "@/components/ui/Field";
import { Checklist } from "./Checklist";
import { periodCode } from "./helpers";
import type { ChecklistItem, PeriodInfo } from "./types";

/** Liste mensuelle : choix de la période puis chargement de sa liste via le proxy. */
export function MonthlyChecklist({ fiscalYear, periods }: { fiscalYear: string; periods: PeriodInfo[] }) {
  const { t, locale } = useI18n();
  const [periodId, setPeriodId] = useState<string>(periods.find((p) => p.status === "OPEN")?.id ?? periods[0]?.id ?? "");
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!periodId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient<ChecklistItem[]>("/closing/checklist", { query: { fiscalYear, period: periodId } })
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fiscalYear, periodId]);

  if (periods.length === 0) return <p className="text-sm text-slate-500">{t("closing.periods.empty")}</p>;

  return (
    <div className="space-y-3">
      <Select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="max-w-xs" aria-label={t("closing.period")}>
        {periods.map((p) => (
          <option key={p.id} value={p.id}>
            {periodCode(p.startDate)} · {formatDate(locale, p.startDate)} → {formatDate(locale, p.endDate)} · {t(`closing.periodStatus.${p.status}`)}
          </option>
        ))}
      </Select>
      {loading ? <p className="text-xs text-slate-500">{t("common.loading")}</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!loading && !error && periodId ? <Checklist key={periodId} fiscalYear={fiscalYear} periodId={periodId} initialItems={items} embedded /> : null}
    </div>
  );
}
