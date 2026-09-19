"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiClient, errorMessage } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { parseAmount } from "@/components/payroll/helpers";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import type { IsComputation, TaxReturn } from "./types";

/** Calculateur d'acomptes d'impôt sur les sociétés (POST /tax/is/instalments). */
export function IsInstalmentsForm({ defaultFiscalYear, currency }: { defaultFiscalYear: string; currency: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [fiscalYear, setFiscalYear] = useState(defaultFiscalYear);
  const [fiscalResult, setFiscalResult] = useState("");
  const [turnover, setTurnover] = useState("");
  const [instalments, setInstalments] = useState("4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IsComputation | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fr = parseAmount(fiscalResult, { allowZero: true, allowNegative: true });
    const ca = parseAmount(turnover, { allowZero: true });
    if (!fr || !ca) return setError(t("tax.is.errorAmounts"));
    const n = Number(instalments);
    setBusy(true);
    try {
      const res = await apiClient<{ taxReturn: TaxReturn; computation: IsComputation }>("/tax/is/instalments", { method: "POST", body: { fiscalYear: fiscalYear.trim(), fiscalResult: fr, turnover: ca, ...(Number.isInteger(n) && n >= 1 && n <= 12 ? { instalments: n } : {}) } });
      setResult(res.computation);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label={t("common.fiscalYear")}>
            <Input value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} required />
          </Field>
          <Field label={t("tax.is.fiscalResult")} hint={t("tax.is.fiscalResultHint")}>
            <Input value={fiscalResult} onChange={(e) => setFiscalResult(e.target.value)} inputMode="decimal" className="text-right font-mono" required />
          </Field>
          <Field label={t("tax.is.turnover")}>
            <Input value={turnover} onChange={(e) => setTurnover(e.target.value)} inputMode="decimal" className="text-right font-mono" required />
          </Field>
          <Field label={t("tax.is.instalments")}>
            <Input type="number" min={1} max={12} value={instalments} onChange={(e) => setInstalments(e.target.value)} />
          </Field>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? t("common.loading") : t("tax.is.compute")}
        </Button>
      </form>
      {result ? (
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Stat label={t("tax.is.isAmount")} value={result.isAmount} currency={currency} />
            <Stat label={t("tax.is.imfAmount")} value={result.imfAmount} currency={currency} />
            <Stat label={t("tax.is.due")} value={result.due} currency={currency} strong />
          </dl>
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 text-left">{t("tax.is.instalment")}</th>
                <th className="py-1 text-left">{t("tax.is.dueDate")}</th>
                <th className="py-1 text-right">{t("common.amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {result.instalments.map((i) => (
                <tr key={i.n}>
                  <td className="py-1">{i.n}</td>
                  <td className="py-1">{i.dueDate ? formatDate(locale, i.dueDate) : "—"}</td>
                  <td className="py-1 text-right"><Money value={i.amount} currency={currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={strong ? "text-lg font-semibold" : "font-medium"}>
        <Money value={value} currency={currency} showCurrency />
      </dd>
    </div>
  );
}
