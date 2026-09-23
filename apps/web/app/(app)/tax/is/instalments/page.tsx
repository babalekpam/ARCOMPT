// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { SubNav } from "@/components/payroll/SubNav";
import { parseIsComputation, returnTone } from "@/components/tax/helpers";
import { IsInstalmentsForm } from "@/components/tax/IsInstalmentsForm";
import { TAX_NAV } from "@/components/tax/nav";
import type { TaxReturn } from "@/components/tax/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function IsInstalmentsPage() {
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const list = await apiTry<TaxReturn[]>("/tax/is/instalments");

  return (
    <>
      <PageHeader title={t("tax.is.title")} subtitle={t("tax.is.subtitle")} />
      <SubNav items={TAX_NAV} />
      <Card>
        <CardTitle hint={t("tax.is.calculatorHint")}>{t("tax.is.calculator")}</CardTitle>
        <IsInstalmentsForm defaultFiscalYear={config.defaultFiscalYear()} currency={currency} />
      </Card>
      <Card className="mt-4">
        <CardTitle hint={t("tax.is.historyHint")}>{t("tax.is.history")}</CardTitle>
        {!list.ok ? <ApiErrorNotice error={list.error} /> : null}
        {list.ok && list.data.length === 0 ? <p className="text-sm text-slate-500">{t("tax.is.empty")}</p> : null}
        {list.ok && list.data.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("tax.period")}</th>
                  <th className="py-2 pr-3">{t("common.status")}</th>
                  <th className="py-2 pr-3 text-right">{t("tax.is.fiscalResult")}</th>
                  <th className="py-2 pr-3 text-right">{t("tax.is.isAmount")}</th>
                  <th className="py-2 pr-3 text-right">{t("tax.is.imfAmount")}</th>
                  <th className="py-2 pr-3 text-right">{t("tax.is.due")}</th>
                  <th className="py-2 text-right">{t("tax.is.instalments")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.data.map((r) => {
                  const c = parseIsComputation(r.data);
                  return (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-3">
                        {formatDate(locale, r.periodFrom)} → {formatDate(locale, r.periodTo)}
                      </td>
                      <td className="py-1.5 pr-3"><Badge tone={returnTone(r.status)}>{t(`tax.returnStatus.${r.status}`)}</Badge></td>
                      <td className="py-1.5 pr-3 text-right">{c ? <Money value={c.fiscalResult} currency={currency} colorSign /> : "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{c ? <Money value={c.isAmount} currency={currency} /> : "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{c ? <Money value={c.imfAmount} currency={currency} dashForZero /> : "—"}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold"><Money value={r.amountDue} currency={currency} /></td>
                      <td className="py-1.5 text-right tabular-nums">{c ? c.instalments.length : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
