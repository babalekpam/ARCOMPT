// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { employeeName, periodLabel, runTone } from "@/components/payroll/helpers";
import { RunActions } from "@/components/payroll/RunActions";
import type { Employee, Payslip, PayrollRun } from "@/components/payroll/types";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const [run, payslips, employees] = await Promise.all([apiTry<PayrollRun>(`/payroll/runs/${id}`), apiTry<Payslip[]>(`/payroll/runs/${id}/payslips`), apiTry<Employee[]>("/payroll/employees")]);
  if (!run.ok && "status" in run.error && run.error.isNotFound) notFound();
  const all = employees.ok ? employees.data : [];
  const names = new Map(all.map((e) => [e.id, { name: employeeName(e), matricule: e.matricule }]));
  const slips = payslips.ok ? payslips.data : [];

  return (
    <>
      <PageHeader
        title={run.ok ? t("payroll.run.title", { period: periodLabel(run.data.year, run.data.month, locale) }) : t("payroll.run.one")}
        subtitle={run.ok ? t("payroll.run.subtitle", { pack: run.data.packVersion }) : undefined}
        actions={
          <LinkButton href="/payroll" variant="secondary" size="sm">
            {t("payroll.back")}
          </LinkButton>
        }
      />
      {!run.ok ? <ApiErrorNotice error={run.error} /> : null}
      {run.ok ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone={runTone(run.data.status)}>{t(`payroll.runStatus.${run.data.status}`)}</Badge>
            <span>{t("payroll.run.statusHint")}</span>
            {run.data.entryId ? (
              <span>
                · {t("payroll.run.entry")} <span className="font-mono">{run.data.entryId}</span>
              </span>
            ) : null}
            {run.data.paymentEntryId ? (
              <span>
                · {t("payroll.run.paymentEntry")} <span className="font-mono">{run.data.paymentEntryId}</span>
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label={t("payroll.gross")} value={run.data.totalGross} currency={currency} />
            <Kpi label={t("payroll.net")} value={run.data.totalNet} currency={currency} />
            <Kpi label={t("payroll.employerCost")} value={run.data.totalEmployerCost} currency={currency} />
            <Kpi label={t("payroll.incomeTax")} value={run.data.totalIncomeTax} currency={currency} />
          </div>
          <Card className="mt-4">
            <CardTitle hint={t("payroll.run.actionsHint")}>{t("payroll.run.actions")}</CardTitle>
            <RunActions run={run.data} employees={all.filter((e) => e.active).map((e) => ({ id: e.id, matricule: e.matricule, name: employeeName(e) }))} payslips={slips} />
          </Card>
          <Card className="mt-4">
            <CardTitle hint={t("payroll.payslips.hint")}>{t("payroll.payslips.title")}</CardTitle>
            {!payslips.ok ? <ApiErrorNotice error={payslips.error} /> : null}
            {payslips.ok && slips.length === 0 ? <p className="text-sm text-slate-500">{t("payroll.payslips.empty")}</p> : null}
            {slips.length > 0 ? (
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">{t("payroll.employee.one")}</th>
                      <th className="py-2 pr-3 text-right">{t("payroll.gross")}</th>
                      <th className="py-2 pr-3 text-right">{t("payroll.employeeContributions")}</th>
                      <th className="py-2 pr-3 text-right">{t("payroll.incomeTax")}</th>
                      <th className="py-2 pr-3 text-right">{t("payroll.net")}</th>
                      <th className="py-2 pr-3 text-right">{t("payroll.netToPay")}</th>
                      <th className="py-2 text-right">{t("payroll.employerCost")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {slips.map((p) => {
                      const e = names.get(p.employeeId);
                      return (
                        <tr key={p.id}>
                          <td className="py-1.5 pr-3">
                            <Link href={`/payroll/payslips/${p.id}`} className="font-medium underline-offset-2 hover:underline">
                              {e?.name ?? p.employeeId}
                            </Link>
                            {e ? <span className="ml-2 font-mono text-[11px] text-slate-500">{e.matricule}</span> : null}
                          </td>
                          <td className="py-1.5 pr-3 text-right"><Money value={p.gross} currency={p.currency} /></td>
                          <td className="py-1.5 pr-3 text-right"><Money value={p.employeeContributions} currency={p.currency} dashForZero /></td>
                          <td className="py-1.5 pr-3 text-right"><Money value={p.incomeTax} currency={p.currency} dashForZero /></td>
                          <td className="py-1.5 pr-3 text-right"><Money value={p.net} currency={p.currency} /></td>
                          <td className="py-1.5 pr-3 text-right font-semibold"><Money value={p.netToPay} currency={p.currency} /></td>
                          <td className="py-1.5 text-right"><Money value={p.employerCost} currency={p.currency} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                      <td className="py-2 pr-3">{t("common.total")}</td>
                      <td className="py-2 pr-3 text-right"><Money value={run.data.totalGross} currency={currency} /></td>
                      <td className="py-2 pr-3 text-right"><Money value={run.data.totalEmployeeContributions} currency={currency} dashForZero /></td>
                      <td className="py-2 pr-3 text-right"><Money value={run.data.totalIncomeTax} currency={currency} dashForZero /></td>
                      <td className="py-2 pr-3 text-right"><Money value={run.data.totalNet} currency={currency} /></td>
                      <td className="py-2 pr-3 text-right" />
                      <td className="py-2 text-right"><Money value={run.data.totalEmployerCost} currency={currency} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}
    </>
  );
}

function Kpi({ label, value, currency }: { label: string; value: string; currency: string }) {
  return (
    <Card as="div">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        <Money value={value} currency={currency} showCurrency dashForZero />
      </p>
    </Card>
  );
}
