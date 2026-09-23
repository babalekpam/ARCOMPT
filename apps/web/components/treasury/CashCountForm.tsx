// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import type { CashCount, CashCountResult } from "./types";

/** Comptage de caisse (comptes CASH) : montant compté, écart calculé par l'API, option de comptabiliser l'écart (658/758). */
export function CashCountForm({ accountId, currency }: { accountId: string; currency: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [postDifference, setPostDifference] = useState(false);
  const [counts, setCounts] = useState<CashCount[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CashCountResult | null>(null);

  const load = useCallback(
    () =>
      apiClient<CashCount[]>(`/treasury/cash/${accountId}/counts`)
        .then(setCounts)
        .catch(() => setCounts([])),
    [accountId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!/^\d+([.,]\d{1,4})?$/.test(counted.trim().replace(/[\s\u00a0\u202f]/g, ""))) return setError(t("treasury.cash.errorAmount"));
    setBusy(true);
    try {
      const r = await apiClient<CashCountResult>(`/treasury/cash/${accountId}/count`, { method: "POST", body: { date, countedAmount: counted.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", "."), ...(note.trim() ? { note: note.trim() } : {}), postDifference } });
      setResult(r);
      setCounted("");
      setNote("");
      await load();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t("common.date")}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label={`${t("treasury.cash.counted")} (${currency})`}>
            <Input value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="decimal" className="text-right font-mono" required />
          </Field>
          <Field label={`${t("common.note")} (${t("common.optional")})`} className="col-span-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={postDifference} onChange={(e) => setPostDifference(e.target.checked)} />
          {t("treasury.cash.postDifference")}
        </label>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {result ? (
          <Alert tone={result.anomaly || result.negativeCash ? "warning" : "success"}>
            {t("treasury.cash.done")} {t("treasury.cash.difference")} <Money value={result.count.difference} currency={currency} colorSign className="font-semibold" />
            {result.entry ? ` · ${t("treasury.cash.entryPosted", { number: result.entry.number ?? "?" })}` : ""}
            {result.negativeCash ? ` · ${t("treasury.cash.negative")}` : ""}
            {result.anomaly ? ` · ${t("treasury.cash.anomaly")}` : ""}
            {result.warnings.length > 0 ? <span className="block text-xs">{result.warnings.join(" · ")}</span> : null}
          </Alert>
        ) : null}
        <Button type="submit" disabled={busy}>
          {busy ? t("common.loading") : t("treasury.cash.submit")}
        </Button>
      </form>
      {counts && counts.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-1 pr-3">{t("common.date")}</th>
              <th className="py-1 pr-3 text-right">{t("treasury.cash.counted")}</th>
              <th className="py-1 pr-3 text-right">{t("treasury.cash.book")}</th>
              <th className="py-1 pr-3 text-right">{t("treasury.cash.difference")}</th>
              <th className="py-1">{t("common.note")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {counts.slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td className="py-1 pr-3">{formatDate(locale, c.countedOn)}</td>
                <td className="py-1 pr-3 text-right"><Money value={c.countedAmount} currency={currency} /></td>
                <td className="py-1 pr-3 text-right"><Money value={c.bookAmount} currency={currency} /></td>
                <td className="py-1 pr-3 text-right"><Money value={c.difference} currency={currency} colorSign dashForZero /></td>
                <td className="py-1 text-xs text-slate-500">{c.note ?? ""}{c.entryId ? ` · ${t("treasury.cash.posted")}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
