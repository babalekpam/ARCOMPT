// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { SubNav } from "@/components/payroll/SubNav";
import { DateRangePicker } from "@/components/tax/DateRangePicker";
import { defaultRange, ISO_DATE_RE } from "@/components/tax/helpers";
import { TAX_NAV } from "@/components/tax/nav";
import type { WithholdingRegister } from "@/components/tax/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function WithholdingPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const dflt = defaultRange(new Date());
  const from = typeof sp.from === "string" && ISO_DATE_RE.test(sp.from) ? sp.from : dflt.from;
  const to = typeof sp.to === "string" && ISO_DATE_RE.test(sp.to) ? sp.to : dflt.to;
  const currency = config.defaultCurrency();
  const reg = await apiTry<WithholdingRegister>("/tax/withholding", { query: { from, to } });

  return (
    <>
      <PageHeader title={t("tax.withholding.title")} subtitle={t("tax.withholding.subtitle")} actions={<DateRangePicker from={from} to={to} />} />
      <SubNav items={TAX_NAV} />
      {!reg.ok ? <ApiErrorNotice error={reg.error} /> : null}
      {reg.ok ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Kpi label={t("tax.withholding.totalWithheld")} value={reg.data.totalWithheld} currency={currency} />
            <Kpi label={t("tax.withholding.totalPaid")} value={reg.data.totalPaid} currency={currency} />
            <Kpi label={t("tax.withholding.balance")} value={reg.data.balance} currency={currency} strong />
          </div>
          <Card className="mt-4">
            <CardTitle hint={t("tax.withholding.hint")}>{t("tax.withholding.register")}</CardTitle>
            {reg.data.rows.length === 0 ? <EmptyState title={t("tax.withholding.empty")} icon="％" /> : null}
            {reg.data.rows.length > 0 ? (
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">{t("common.date")}</th>
                      <th className="py-2 pr-3">{t("common.reference")}</th>
                      <th className="py-2 pr-3">{t("common.label")}</th>
                      <th className="py-2 pr-3">{t("tax.withholding.partner")}</th>
                      <th className="py-2 pr-3">{t("common.account")}</th>
                      <th className="py-2 pr-3 text-right">{t("tax.withholding.withheld")}</th>
                      <th className="py-2 text-right">{t("tax.withholding.paid")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {reg.data.rows.map((r, i) => (
                      <tr key={`${r.entryId}-${i}`}>
                        <td className="py-1.5 pr-3">{formatDate(locale, r.date)}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{r.reference ?? "—"}</td>
                        <td className="py-1.5 pr-3">
                          <div>{r.entryLabel}</div>
                          {r.lineLabel !== r.entryLabel ? <div className="text-xs text-slate-500">{r.lineLabel}</div> : null}
                        </td>
                        <td className="py-1.5 pr-3">{r.partnerName ?? "—"}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{r.accountNumber}</td>
                        <td className="py-1.5 pr-3 text-right"><Money value={r.withheld} currency={currency} dashForZero /></td>
                        <td className="py-1.5 text-right"><Money value={r.paid} currency={currency} dashForZero /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                      <td className="py-2 pr-3" colSpan={5}>{t("common.total")}</td>
                      <td className="py-2 pr-3 text-right"><Money value={reg.data.totalWithheld} currency={currency} /></td>
                      <td className="py-2 text-right"><Money value={reg.data.totalPaid} currency={currency} /></td>
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

function Kpi({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <Card as="div" className={strong ? "border-slate-900 dark:border-slate-100" : ""}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        <Money value={value} currency={currency} showCurrency colorSign />
      </p>
    </Card>
  );
}
