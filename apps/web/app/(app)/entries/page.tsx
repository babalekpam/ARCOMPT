import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import type { TrialBalance } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FiscalYearPicker } from "@/components/FiscalYearPicker";
import { RecentEntries } from "@/components/dashboard/RecentEntries";
import { ChainCheck } from "@/components/entries/ChainCheck";
import { EntryByIdActions } from "@/components/entries/EntryByIdActions";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function EntriesPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const { fiscalYear } = resolveFiscalYear(await searchParams);
  const currency = config.defaultCurrency();
  const tb = await apiTry<TrialBalance>("/entries/trial-balance", { query: { fiscalYear } });
  const rows = tb.ok ? tb.data.rows.filter((r) => r.debit !== "0.0000" || r.credit !== "0.0000") : [];
  return (
    <>
      <PageHeader
        title={t("entries.title")}
        subtitle={t("entries.subtitle")}
        actions={
          <>
            <FiscalYearPicker value={fiscalYear} />
            <LinkButton href="/entries/new">{t("entries.new")}</LinkButton>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint={t("entries.recentHint")}>{t("entries.recent")}</CardTitle>
          <RecentEntries currency={currency} withActions />
        </Card>
        <div className="space-y-4">
          <Card>
            <CardTitle hint={t("entries.byIdHint")}>{t("entries.byId")}</CardTitle>
            <EntryByIdActions />
          </Card>
          <Card>
            <CardTitle hint={t("entries.chainHint")}>{t("entries.chain")}</CardTitle>
            <ChainCheck />
          </Card>
        </div>
      </div>
      <Card className="mt-4">
        <CardTitle hint={t("entries.movementsHint")}>{t("entries.movements")}</CardTitle>
        {!tb.ok ? <ApiErrorNotice error={tb.error} /> : null}
        {tb.ok && rows.length === 0 ? <p className="text-sm text-slate-500">{t("entries.noMovements", { fy: fiscalYear })}</p> : null}
        {rows.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("common.account")}</th>
                  <th className="py-2 pr-3">{t("common.label")}</th>
                  <th className="py-2 pr-3 text-right">{t("common.debit")}</th>
                  <th className="py-2 text-right">{t("common.credit")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.accountNumber}>
                    <td className="py-1.5 pr-3 font-mono text-xs">{r.accountNumber}</td>
                    <td className="py-1.5 pr-3">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right"><Money value={r.debit} currency={currency} dashForZero /></td>
                    <td className="py-1.5 text-right"><Money value={r.credit} currency={currency} dashForZero /></td>
                  </tr>
                ))}
              </tbody>
              {tb.ok ? (
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                    <td className="py-2 pr-3" colSpan={2}>{t("common.total")}</td>
                    <td className="py-2 pr-3 text-right"><Money value={tb.data.totalDebit} currency={currency} /></td>
                    <td className="py-2 text-right"><Money value={tb.data.totalCredit} currency={currency} /></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
