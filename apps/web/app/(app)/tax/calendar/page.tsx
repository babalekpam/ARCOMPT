import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { resolvePeriod } from "@/components/payroll/nav";
import { PeriodPicker } from "@/components/payroll/PeriodPicker";
import { SubNav } from "@/components/payroll/SubNav";
import { deadlineTone } from "@/components/tax/helpers";
import { TAX_NAV } from "@/components/tax/nav";
import type { Deadline } from "@/components/tax/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function TaxCalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { year } = resolvePeriod(await searchParams);
  const res = await apiTry<Deadline[]>("/tax/calendar", { query: { year } });
  const counts = res.ok ? res.data.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {}) : {};

  return (
    <>
      <PageHeader title={t("tax.calendar.title")} subtitle={t("tax.calendar.subtitle", { year })} actions={<PeriodPicker year={year} />} />
      <SubNav items={TAX_NAV} />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok && res.data.length === 0 ? <EmptyState title={t("tax.calendar.empty", { year })} body={t("tax.calendar.emptyBody")} icon="▦" /> : null}
      {res.ok && res.data.length > 0 ? (
        <Card>
          <CardTitle
            hint={t("tax.calendar.hint")}
            action={
              <div className="flex flex-wrap gap-1">
                {(["OVERDUE", "DUE_SOON", "UPCOMING", "DONE"] as const).map((s) => (
                  <Badge key={s} tone={deadlineTone(s)}>
                    {t(`tax.deadlineStatus.${s}`)} {counts[s] ?? 0}
                  </Badge>
                ))}
              </div>
            }
          >
            {t("tax.calendar.deadlines")}
          </CardTitle>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("tax.calendar.dueDate")}</th>
                  <th className="py-2 pr-3">{t("tax.calendar.obligation")}</th>
                  <th className="py-2 pr-3">{t("tax.period")}</th>
                  <th className="py-2 pr-3">{t("tax.calendar.frequency")}</th>
                  <th className="py-2">{t("common.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {res.data.map((d) => (
                  <tr key={`${d.calendarId}-${d.periodFrom}`} className={d.status === "OVERDUE" ? "bg-red-50/60 dark:bg-red-950/20" : ""}>
                    <td className="py-1.5 pr-3 font-medium tabular-nums">{formatDate(locale, d.dueDate)}</td>
                    <td className="py-1.5 pr-3">
                      <div>{d.label}</div>
                      <div className="font-mono text-[11px] text-slate-500">{d.calendarId}{d.kind ? ` · ${d.kind}` : ""}</div>
                    </td>
                    <td className="py-1.5 pr-3">{d.periodLabel}</td>
                    <td className="py-1.5 pr-3">{t(`tax.frequency.${d.frequency}`)}</td>
                    <td className="py-1.5"><Badge tone={deadlineTone(d.status)}>{t(`tax.deadlineStatus.${d.status}`)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
