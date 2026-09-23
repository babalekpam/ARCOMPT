// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { employeeName, isMasked, periodLabel, runTone } from "@/components/payroll/helpers";
import { PAYROLL_NAV, resolvePeriod } from "@/components/payroll/nav";
import { NewRunForm } from "@/components/payroll/NewRunForm";
import { PeriodPicker } from "@/components/payroll/PeriodPicker";
import { SubNav } from "@/components/payroll/SubNav";
import type { Employee, PayrollRun } from "@/components/payroll/types";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function PayrollPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { year } = resolvePeriod(await searchParams);
  const currency = config.defaultCurrency();
  const [employees, runs] = await Promise.all([apiTry<Employee[]>("/payroll/employees"), apiTry<PayrollRun[]>("/payroll/runs", { query: { year } })]);
  const list = employees.ok ? employees.data : [];
  const active = list.filter((e) => e.active);

  return (
    <>
      <PageHeader title={t("payroll.title")} subtitle={t("payroll.subtitle")} actions={<LinkButton href="/payroll/employees/new">{t("payroll.employee.new")}</LinkButton>} />
      <SubNav items={PAYROLL_NAV} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint={t("payroll.runs.hint")} action={<PeriodPicker year={year} />}>
            {t("payroll.runs.title", { year })}
          </CardTitle>
          {!runs.ok ? <ApiErrorNotice error={runs.error} /> : null}
          {runs.ok && runs.data.length === 0 ? <p className="mb-3 text-sm text-slate-500">{t("payroll.runs.empty", { year })}</p> : null}
          {runs.ok && runs.data.length > 0 ? (
            <div className="-mx-4 mb-3 overflow-x-auto px-4">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("payroll.period")}</th>
                    <th className="py-2 pr-3">{t("common.status")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.employees.count")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.gross")}</th>
                    <th className="py-2 pr-3 text-right">{t("payroll.net")}</th>
                    <th className="py-2 text-right">{t("payroll.employerCost")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {runs.data.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-3">
                        <Link href={`/payroll/runs/${r.id}`} className="font-medium underline-offset-2 hover:underline">
                          {periodLabel(r.year, r.month, locale)}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-3"><Badge tone={runTone(r.status)}>{t(`payroll.runStatus.${r.status}`)}</Badge></td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.employeeCount}</td>
                      <td className="py-1.5 pr-3 text-right"><Money value={r.totalGross} currency={currency} dashForZero /></td>
                      <td className="py-1.5 pr-3 text-right"><Money value={r.totalNet} currency={currency} dashForZero /></td>
                      <td className="py-1.5 text-right"><Money value={r.totalEmployerCost} currency={currency} dashForZero /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {runs.ok ? (
            <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("payroll.runs.new")}</p>
              <NewRunForm defaultYear={year} />
            </div>
          ) : null}
        </Card>
        <Card>
          <CardTitle hint={t("payroll.employees.hint")}>{t("payroll.employees.title")}</CardTitle>
          {!employees.ok ? <ApiErrorNotice error={employees.error} /> : null}
          {employees.ok ? (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-slate-500">{t("payroll.employees.active")}</dt>
                <dd className="text-xl font-semibold">{active.length}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t("payroll.employees.inactive")}</dt>
                <dd className="text-xl font-semibold">{list.length - active.length}</dd>
              </div>
            </dl>
          ) : null}
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle hint={t("payroll.employees.listHint")}>{t("payroll.employees.list")}</CardTitle>
        {employees.ok && list.length === 0 ? (
          <EmptyState title={t("payroll.employees.emptyTitle")} body={t("payroll.employees.emptyBody")} action={<LinkButton href="/payroll/employees/new">{t("payroll.employee.new")}</LinkButton>} icon="☺" />
        ) : null}
        {list.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("payroll.employee.matricule")}</th>
                  <th className="py-2 pr-3">{t("payroll.employee.one")}</th>
                  <th className="py-2 pr-3">{t("payroll.employee.contractType")}</th>
                  <th className="py-2 pr-3">{t("payroll.employee.hireDate")}</th>
                  <th className="py-2 pr-3 text-right">{t("payroll.employee.baseSalary")}</th>
                  <th className="py-2">{t("common.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.map((e) => (
                  <tr key={e.id} className={e.active ? "" : "text-slate-400"}>
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.matricule}</td>
                    <td className="py-1.5 pr-3">
                      <Link href={`/payroll/employees/${e.id}`} className="font-medium underline-offset-2 hover:underline">
                        {employeeName(e)}
                      </Link>
                      {e.category ? <span className="ml-2 text-xs text-slate-500">{e.category}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3">{t(`payroll.contractType.${e.contractType}`)}</td>
                    <td className="py-1.5 pr-3">{formatDate(locale, e.hireDate)}</td>
                    <td className="py-1.5 pr-3 text-right">{isMasked(e.baseSalary) ? <span className="font-mono text-slate-400">***</span> : <Money value={e.baseSalary} currency={currency} />}</td>
                    <td className="py-1.5"><Badge tone={e.active ? "success" : "neutral"}>{e.active ? t("payroll.employee.activeBadge") : t("payroll.employee.inactiveBadge")}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
