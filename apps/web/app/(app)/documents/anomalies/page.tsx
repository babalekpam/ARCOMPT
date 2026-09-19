import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocumentsNav } from "@/components/documents/DocumentsNav";
import { defaultAnomalyPeriod, isIsoDate } from "@/components/documents/helpers";
import type { AnomaliesResponse } from "@/components/documents/types";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

/** Anomalies détectées sur une période : caisse négative, TVA incohérente, doublons, montants inhabituels. */
export default async function AnomaliesPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const def = defaultAnomalyPeriod(new Date().toISOString().slice(0, 10));
  const from = isIsoDate(sp.from) ? sp.from : def.from;
  const to = isIsoDate(sp.to) ? sp.to : def.to;
  const res = await apiTry<AnomaliesResponse>("/anomalies", { query: { from, to } });
  const currency = config.defaultCurrency();
  return (
    <>
      <PageHeader
        title={t("documents.anomalies.title")}
        subtitle={t("documents.anomalies.subtitle")}
        actions={
          <form method="get" className="flex items-end gap-2">
            <label className="text-xs text-slate-500">
              {t("common.from")}
              <Input type="date" name="from" defaultValue={from} className="mt-1" />
            </label>
            <label className="text-xs text-slate-500">
              {t("common.to")}
              <Input type="date" name="to" defaultValue={to} className="mt-1" />
            </label>
            <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              {t("common.apply")}
            </button>
          </form>
        }
      />
      <DocumentsNav />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok ? (
        <>
          <p className="mb-3 text-xs text-slate-500">{t("documents.anomalies.period", { from: formatDate(locale, res.data.period.from), to: formatDate(locale, res.data.period.to), n: res.data.anomalies.length })}</p>
          {res.data.anomalies.length === 0 ? (
            <EmptyState title={t("documents.anomalies.empty")} icon="✔" />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {res.data.anomalies.map((a, i) => (
                <li key={`${a.code}-${i}`} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                  <Badge tone={a.severity === "ERROR" ? "danger" : "warning"} className="mt-0.5">{t(`documents.anomalies.severity.${a.severity}`)}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t(`documents.anomalies.code.${a.code}`)}</span>
                      {a.accountNumber ? <span className="font-mono text-xs text-slate-500">{a.accountNumber}</span> : null}
                      {a.date ? <span className="text-xs text-slate-500">{formatDate(locale, a.date)}</span> : null}
                      {a.amount ? <Money value={a.amount} currency={currency} showCurrency className="text-xs" /> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{a.message}</p>
                    {a.entryIds.length > 0 ? (
                      <p className="mt-1 font-mono text-[11px] text-slate-400">
                        {t("documents.anomalies.entries")} {a.entryIds.join(", ")}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
}
