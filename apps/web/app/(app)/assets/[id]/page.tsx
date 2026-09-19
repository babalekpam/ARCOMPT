import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { AssetActions } from "@/components/assets/AssetActions";
import { cumulativeDepreciation, netBookValue } from "@/components/assets/helpers";
import type { AssetSchedule } from "@/components/assets/types";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AssetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const res = await apiTry<AssetSchedule>(`/assets/${id}/schedule`);
  if (!res.ok && "status" in res.error && res.error.isNotFound) notFound();
  const asset = res.ok ? res.data.asset : null;
  const posted = res.ok ? res.data.posted : [];
  const plan = res.ok ? res.data.plan : [];
  const cumulative = asset ? cumulativeDepreciation(asset, posted) : "0";
  const net = asset ? netBookValue(asset, posted) : "0";

  return (
    <>
      <PageHeader
        title={asset?.label ?? t("assets.one")}
        subtitle={asset ? `${t(`assets.categories.${asset.category}`)} · ${asset.accountNumber}${asset.reference ? ` · ${asset.reference}` : ""}` : undefined}
        actions={
          <>
            <LinkButton href="/assets" variant="secondary" size="sm">
              {t("assets.back")}
            </LinkButton>
            {asset ? <AssetActions asset={asset} canDelete={posted.length === 0 && !asset.disposedOn} currency={currency} /> : null}
          </>
        }
      />
      {sp.created === "1" ? <Alert tone="success" className="mb-4">{t("assets.created")}</Alert> : null}
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {asset ? (
        <>
          {asset.disposedOn ? (
            <Alert tone="info" className="mb-4">
              {t("assets.disposedNotice", { date: formatDate(locale, asset.disposedOn) })} <Money value={asset.disposalPrice} currency={currency} showCurrency />
              {asset.disposalEntryId ? <span className="ml-2 font-mono text-xs">{asset.disposalEntryId}</span> : null}
            </Alert>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Kpi label={t("assets.gross")} value={asset.cost} currency={currency} />
            <Kpi label={t("assets.cumulative")} value={cumulative} currency={currency} />
            <Kpi label={t("assets.netBookValue")} value={net} currency={currency} strong />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardTitle>{t("assets.sheet")}</CardTitle>
              <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                <Row label={t("assets.acquiredOn")} value={formatDate(locale, asset.acquiredOn)} />
                <Row label={t("assets.inServiceOn")} value={formatDate(locale, asset.inServiceOn)} />
                <Row label={t("assets.method")} value={t(`assets.methods.${asset.method}`)} />
                {asset.durationMonths ? <Row label={t("assets.durationMonths")} value={String(asset.durationMonths)} /> : null}
                <Row label={t("assets.prorata")} value={t(`assets.prorataKind.${asset.prorata}`)} />
                {asset.degressiveCoefficient ? <Row label={t("assets.form.coefficient")} value={asset.degressiveCoefficient} /> : null}
                <Row label={t("assets.form.residualValue")} value={<Money value={asset.residualValue} currency={currency} dashForZero />} />
                <Row label={t("assets.form.priorDepreciation")} value={<Money value={asset.priorDepreciation} currency={currency} dashForZero />} />
                <Row label={t("assets.form.depreciationAccount")} value={<span className="font-mono text-xs">{asset.depreciationAccountNumber ?? "—"}</span>} />
                <Row label={t("assets.form.expenseAccount")} value={<span className="font-mono text-xs">{asset.expenseAccountNumber}</span>} />
                <Row label={t("assets.acquisitionEntry")} value={<span className="font-mono text-[11px]">{asset.acquisitionEntryId ?? "—"}</span>} />
              </dl>
            </Card>
            <Card className="lg:col-span-2">
              <CardTitle hint={t("assets.scheduleHint")}>{t("assets.schedule")}</CardTitle>
              {plan.length === 0 ? <p className="text-sm text-slate-500">{t("assets.noSchedule")}</p> : null}
              {plan.length > 0 ? (
                <div className="-mx-4 overflow-x-auto px-4">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                        <th className="py-2 pr-3">#</th>
                        <th className="py-2 pr-3">{t("assets.period")}</th>
                        <th className="py-2 pr-3 text-right">{t("assets.base")}</th>
                        <th className="py-2 pr-3 text-right">{t("assets.dotation")}</th>
                        <th className="py-2 pr-3 text-right">{t("assets.cumulative")}</th>
                        <th className="py-2 text-right">{t("assets.netBookValue")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {plan.map((p) => {
                        const done = posted.some((r) => r.periodEnd === p.periodEnd);
                        return (
                          <tr key={p.index} className={done ? "" : "text-slate-500"}>
                            <td className="py-1.5 pr-3 tabular-nums">{p.index + 1}</td>
                            <td className="py-1.5 pr-3">
                              {formatDate(locale, p.periodStart)} → {formatDate(locale, p.periodEnd)}
                              {p.fraction ? <span className="ml-1 text-xs text-slate-400">({p.fraction})</span> : null}
                              {done ? <Badge tone="success" className="ml-2">{t("assets.posted")}</Badge> : null}
                            </td>
                            <td className="py-1.5 pr-3 text-right"><Money value={p.base} currency={currency} /></td>
                            <td className="py-1.5 pr-3 text-right"><Money value={p.dotation} currency={currency} /></td>
                            <td className="py-1.5 pr-3 text-right"><Money value={p.cumulative} currency={currency} /></td>
                            <td className="py-1.5 text-right"><Money value={p.netBookValue} currency={currency} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </Card>
          </div>
          <Card className="mt-4">
            <CardTitle hint={t("assets.postedHint")}>{t("assets.postedRows")}</CardTitle>
            {posted.length === 0 ? <p className="text-sm text-slate-500">{t("assets.noPosted")}</p> : null}
            {posted.length > 0 ? (
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">{t("assets.periodEnd")}</th>
                      <th className="py-2 pr-3 text-right">{t("assets.dotation")}</th>
                      <th className="py-2 pr-3 text-right">{t("assets.cumulative")}</th>
                      <th className="py-2 pr-3 text-right">{t("assets.netBookValue")}</th>
                      <th className="py-2">{t("assets.entry")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {posted.map((r) => (
                      <tr key={r.id}>
                        <td className="py-1.5 pr-3">{formatDate(locale, r.periodEnd)}</td>
                        <td className="py-1.5 pr-3 text-right"><Money value={r.dotation} currency={currency} /></td>
                        <td className="py-1.5 pr-3 text-right"><Money value={r.cumulative} currency={currency} /></td>
                        <td className="py-1.5 pr-3 text-right"><Money value={r.netBookValue} currency={currency} /></td>
                        <td className="py-1.5 font-mono text-[11px] text-slate-500">{r.entryId ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function Kpi({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <Card as="div" className={strong ? "border-slate-900 dark:border-slate-100" : ""}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        <Money value={value} currency={currency} showCurrency />
      </p>
    </Card>
  );
}
