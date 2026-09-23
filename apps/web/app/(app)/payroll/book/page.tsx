// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { periodLabel, runTone } from "@/components/payroll/helpers";
import { PAYROLL_NAV, resolvePeriod } from "@/components/payroll/nav";
import { PeriodPicker } from "@/components/payroll/PeriodPicker";
import { SubNav } from "@/components/payroll/SubNav";
import type { PayrollBook } from "@/components/payroll/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

const COLS = ["gross", "employeeContributions", "employerContributions", "incomeTax", "net", "employerCost"] as const;

export default async function PayrollBookPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { year } = resolvePeriod(await searchParams);
  const book = await apiTry<PayrollBook>("/payroll/book", { query: { year } });

  return (
    <>
      <PageHeader title={t("payroll.book.title")} subtitle={t("payroll.book.subtitle", { year })} actions={<PeriodPicker year={year} />} />
      <SubNav items={PAYROLL_NAV} />
      {!book.ok ? <ApiErrorNotice error={book.error} /> : null}
      {book.ok && book.data.rows.length === 0 ? <EmptyState title={t("payroll.book.empty", { year })} body={t("payroll.book.emptyBody")} icon="▤" /> : null}
      {book.ok && book.data.rows.length > 0 ? (
        <>
          <Card>
            <CardTitle hint={t("payroll.book.monthsHint")}>{t("payroll.book.months")}</CardTitle>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("payroll.month")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.employees.count")}</th>
                    {COLS.map((c) => (
                      <th key={c} className="py-2 pr-3 text-right">{t(`payroll.${c}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {book.data.months.map((m) => (
                    <tr key={m.month}>
                      <td className="py-1.5 pr-3">{periodLabel(book.data.year, m.month, locale)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{m.employees}</td>
                      {COLS.map((c) => (
                        <td key={c} className="py-1.5 pr-3 text-right"><Money value={m[c]} currency={book.data.currency} dashForZero /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                    <td className="py-2 pr-3" colSpan={2}>{t("common.total")}</td>
                    {COLS.map((c) => (
                      <td key={c} className="py-2 pr-3 text-right"><Money value={book.data.totals[c]} currency={book.data.currency} /></td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
          <Card className="mt-4">
            <CardTitle hint={t("payroll.book.rowsHint")}>{t("payroll.book.rows")}</CardTitle>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[60rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("payroll.employee.one")}</th>
                    <th className="py-2 pr-3">{t("payroll.month")}</th>
                    <th className="py-2 pr-3">{t("common.status")}</th>
                    {COLS.map((c) => (
                      <th key={c} className="py-2 pr-3 text-right">{t(`payroll.${c}`)}</th>
                    ))}
                    <th className="py-2 text-right">{t("payroll.netToPay")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {book.data.rows.map((r) => (
                    <tr key={`${r.employeeId}-${r.month}`}>
                      <td className="py-1.5 pr-3">
                        <span className="font-medium">{r.fullName}</span>
                        <span className="ml-2 font-mono text-[11px] text-slate-500">{r.matricule}</span>
                      </td>
                      <td className="py-1.5 pr-3">{periodLabel(r.year, r.month, locale)}</td>
                      <td className="py-1.5 pr-3"><Badge tone={runTone(r.runStatus)}>{t(`payroll.runStatus.${r.runStatus}`)}</Badge></td>
                      {COLS.map((c) => (
                        <td key={c} className="py-1.5 pr-3 text-right"><Money value={r[c]} currency={book.data.currency} dashForZero /></td>
                      ))}
                      <td className="py-1.5 text-right font-semibold"><Money value={r.netToPay} currency={book.data.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}
