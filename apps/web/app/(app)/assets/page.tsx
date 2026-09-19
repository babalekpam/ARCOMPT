import Link from "next/link";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FiscalYearPicker } from "@/components/FiscalYearPicker";
import { cumulativeDepreciation, listTotals, netBookValue, type AssetListRow } from "@/components/assets/helpers";
import { ASSETS_NAV } from "@/components/assets/nav";
import { RunDepreciation } from "@/components/assets/RunDepreciation";
import type { AssetSchedule, FixedAsset } from "@/components/assets/types";
import { SubNav } from "@/components/payroll/SubNav";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AssetsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const { fiscalYear } = resolveFiscalYear(sp);
  const includeDisposed = sp.disposed === "1";
  const currency = config.defaultCurrency();
  const list = await apiTry<FixedAsset[]>("/assets", { query: { includeDisposed: includeDisposed ? "true" : undefined } });
  // Les amortissements cumulés viennent des dotations enregistrées (une lecture par fiche).
  const rows: AssetListRow[] = list.ok
    ? await Promise.all(
        list.data.map(async (asset) => {
          const s = await apiTry<AssetSchedule>(`/assets/${asset.id}/schedule`);
          const posted = s.ok ? s.data.posted : [];
          return { asset, cumulative: cumulativeDepreciation(asset, posted), net: netBookValue(asset, posted) };
        }),
      )
    : [];
  const totals = listTotals(rows);

  return (
    <>
      <PageHeader
        title={t("assets.title")}
        subtitle={t("assets.subtitle")}
        actions={
          <>
            <FiscalYearPicker value={fiscalYear} />
            <LinkButton href="/assets/new">{t("assets.new")}</LinkButton>
          </>
        }
      />
      <SubNav items={ASSETS_NAV} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-2">
          <Kpi label={t("assets.gross")} value={totals.cost} currency={currency} />
          <Kpi label={t("assets.cumulative")} value={totals.cumulative} currency={currency} />
          <Kpi label={t("assets.netBookValue")} value={totals.net} currency={currency} strong />
        </div>
        <Card>
          <CardTitle hint={t("assets.run.hint", { fy: fiscalYear })}>{t("assets.run.title")}</CardTitle>
          <RunDepreciation fiscalYear={fiscalYear} />
        </Card>
      </div>
      <Card className="mt-4">
        <CardTitle
          hint={t("assets.listHint")}
          action={
            <Link href={`/assets?fy=${fiscalYear}${includeDisposed ? "" : "&disposed=1"}`} className="text-xs underline">
              {includeDisposed ? t("assets.hideDisposed") : t("assets.showDisposed")}
            </Link>
          }
        >
          {t("assets.list")}
        </CardTitle>
        {!list.ok ? <ApiErrorNotice error={list.error} /> : null}
        {list.ok && rows.length === 0 ? <EmptyState title={t("assets.emptyTitle")} body={t("assets.emptyBody")} action={<LinkButton href="/assets/new">{t("assets.new")}</LinkButton>} icon="▥" /> : null}
        {rows.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("common.label")}</th>
                  <th className="py-2 pr-3">{t("assets.category")}</th>
                  <th className="py-2 pr-3">{t("common.account")}</th>
                  <th className="py-2 pr-3">{t("assets.acquiredOn")}</th>
                  <th className="py-2 pr-3">{t("assets.method")}</th>
                  <th className="py-2 pr-3 text-right">{t("assets.gross")}</th>
                  <th className="py-2 pr-3 text-right">{t("assets.cumulative")}</th>
                  <th className="py-2 text-right">{t("assets.netBookValue")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map(({ asset, cumulative, net }) => (
                  <tr key={asset.id} className={asset.disposedOn ? "text-slate-400" : ""}>
                    <td className="py-1.5 pr-3">
                      <Link href={`/assets/${asset.id}`} className="font-medium underline-offset-2 hover:underline">
                        {asset.label}
                      </Link>
                      {asset.reference ? <span className="ml-2 font-mono text-[11px] text-slate-500">{asset.reference}</span> : null}
                      {asset.disposedOn ? <Badge tone="neutral" className="ml-2">{t("assets.disposedOn", { date: formatDate(locale, asset.disposedOn) })}</Badge> : null}
                    </td>
                    <td className="py-1.5 pr-3">{t(`assets.categories.${asset.category}`)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{asset.accountNumber}</td>
                    <td className="py-1.5 pr-3">{formatDate(locale, asset.acquiredOn)}</td>
                    <td className="py-1.5 pr-3 text-xs">
                      {t(`assets.methods.${asset.method}`)}
                      {asset.durationMonths ? ` · ${asset.durationMonths} ${t("assets.monthsShort")}` : ""}
                    </td>
                    <td className="py-1.5 pr-3 text-right"><Money value={asset.cost} currency={currency} /></td>
                    <td className="py-1.5 pr-3 text-right"><Money value={cumulative} currency={currency} dashForZero /></td>
                    <td className="py-1.5 text-right font-semibold"><Money value={net} currency={currency} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                  <td className="py-2 pr-3" colSpan={5}>{t("common.total")}</td>
                  <td className="py-2 pr-3 text-right"><Money value={totals.cost} currency={currency} /></td>
                  <td className="py-2 pr-3 text-right"><Money value={totals.cumulative} currency={currency} /></td>
                  <td className="py-2 text-right"><Money value={totals.net} currency={currency} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : null}
      </Card>
    </>
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
