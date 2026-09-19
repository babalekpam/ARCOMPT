import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FiscalYearPicker } from "@/components/FiscalYearPicker";
import { groupNoteRows, NOTE_COLUMNS } from "@/components/assets/helpers";
import { ASSETS_NAV } from "@/components/assets/nav";
import type { AssetNotes } from "@/components/assets/types";
import { SubNav } from "@/components/payroll/SubNav";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AssetNotesPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { fiscalYear } = resolveFiscalYear(await searchParams);
  const currency = config.defaultCurrency();
  const res = await apiTry<AssetNotes>("/assets/notes", { query: { fiscalYear } });
  const groups = res.ok ? groupNoteRows(res.data.rows) : [];

  return (
    <>
      <PageHeader title={t("assets.notes.title")} subtitle={t("assets.notes.subtitle", { fy: fiscalYear })} actions={<FiscalYearPicker value={fiscalYear} />} />
      <SubNav items={ASSETS_NAV} />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok && res.data.rows.length === 0 ? <EmptyState title={t("assets.notes.empty", { fy: fiscalYear })} icon="▥" /> : null}
      {res.ok && res.data.rows.length > 0 ? (
        <Card>
          <CardTitle hint={t("assets.notes.hint", { from: formatDate(locale, res.data.from), to: formatDate(locale, res.data.to) })}>{t("assets.notes.table")}</CardTitle>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[72rem] text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-3 text-left" rowSpan={2}>{t("common.label")}</th>
                  <th className="py-1 text-center" colSpan={4}>{t("assets.notes.grossGroup")}</th>
                  <th className="py-1 text-center" colSpan={4}>{t("assets.notes.depreciationGroup")}</th>
                  <th className="py-2 text-right" rowSpan={2}>{t("assets.notes.netClosing")}</th>
                </tr>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  {NOTE_COLUMNS.slice(0, 8).map((c) => (
                    <th key={c} className="py-1 pr-3 text-right font-normal">{t(`assets.notes.${c}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {groups.map((g) => (
                  <GroupRows key={g.group} group={g.group} rows={g.rows} currency={currency} />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                  <td className="py-2 pr-3">{t("common.total")}</td>
                  {NOTE_COLUMNS.map((c) => (
                    <td key={c} className={`py-2 text-right ${c === "netClosing" ? "" : "pr-3"}`}><Money value={res.data.total[c]} currency={currency} dashForZero /></td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

function GroupRows({ group, rows, currency }: { group: string; rows: AssetNotes["rows"]; currency: string }) {
  return (
    <>
      <tr className="bg-slate-50 text-xs font-semibold uppercase tracking-wide dark:bg-slate-800/60">
        <td colSpan={10} className="px-1 py-1">{group}</td>
      </tr>
      {rows.map((r, i) => (
        <tr key={`${group}-${i}`}>
          <td className="py-1.5 pl-3 pr-3">{r.label}</td>
          {NOTE_COLUMNS.map((c) => (
            <td key={c} className={`py-1.5 text-right ${c === "netClosing" ? "font-semibold" : "pr-3"}`}><Money value={r[c]} currency={currency} dashForZero /></td>
          ))}
        </tr>
      ))}
    </>
  );
}
