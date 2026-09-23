// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DeclarationFileButton } from "@/components/payroll/DeclarationFileButton";
import { periodLabel } from "@/components/payroll/helpers";
import { PAYROLL_NAV, resolvePeriod } from "@/components/payroll/nav";
import { PeriodPicker } from "@/components/payroll/PeriodPicker";
import { SubNav } from "@/components/payroll/SubNav";
import type { PayrollDeclaration } from "@/components/payroll/types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

const TONES: Record<PayrollDeclaration["status"], BadgeTone> = { DRAFT: "neutral", FILED: "info", PAID: "success" };

export default async function PayrollDeclarationsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { year, month } = resolvePeriod(await searchParams);
  const currency = config.defaultCurrency();
  const res = await apiTry<PayrollDeclaration[]>("/payroll/declarations", { query: { year, month } });

  return (
    <>
      <PageHeader title={t("payroll.declarations.title")} subtitle={t("payroll.declarations.subtitle", { period: periodLabel(year, month, locale) })} actions={<PeriodPicker year={year} month={month} />} />
      <SubNav items={PAYROLL_NAV} />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok && res.data.length === 0 ? <EmptyState title={t("payroll.declarations.empty")} body={t("payroll.declarations.emptyBody")} icon="✦" /> : null}
      {res.ok && res.data.length > 0 ? (
        <Card>
          <CardTitle hint={t("payroll.declarations.hint")}>{periodLabel(year, month, locale)}</CardTitle>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("payroll.declarations.kind")}</th>
                  <th className="py-2 pr-3">{t("common.account")}</th>
                  <th className="py-2 pr-3 text-right">{t("payroll.payslip.base")}</th>
                  <th className="py-2 pr-3 text-right">{t("payroll.declarations.employeeShare")}</th>
                  <th className="py-2 pr-3 text-right">{t("payroll.declarations.employerShare")}</th>
                  <th className="py-2 pr-3 text-right">{t("common.amount")}</th>
                  <th className="py-2 pr-3">{t("common.status")}</th>
                  <th className="py-2 text-right">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {res.data.map((d) => (
                  <tr key={d.id}>
                    <td className="py-1.5 pr-3">
                      <div className="font-medium">{d.label}</div>
                      <div className="font-mono text-[11px] text-slate-500">{d.kind}</div>
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{d.account}</td>
                    <td className="py-1.5 pr-3 text-right"><Money value={d.base} currency={currency} dashForZero /></td>
                    <td className="py-1.5 pr-3 text-right"><Money value={d.employeeAmount} currency={currency} dashForZero /></td>
                    <td className="py-1.5 pr-3 text-right"><Money value={d.employerAmount} currency={currency} dashForZero /></td>
                    <td className="py-1.5 pr-3 text-right font-semibold"><Money value={d.amount} currency={currency} /></td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={TONES[d.status]}>{t(`payroll.declarationStatus.${d.status}`)}</Badge>
                      {d.filingReference ? (
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {d.filingReference} · {formatDate(locale, d.filedAt)}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-right">{d.status === "DRAFT" ? <DeclarationFileButton declaration={d} /> : null}</td>
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
