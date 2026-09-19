import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FirmNav } from "@/components/firm/FirmNav";
import { isMonth, monthOf } from "@/components/firm/helpers";
import type { OrganizationInvoice } from "@/components/firm/types";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

/** Facturation du cabinet pour un mois : dossiers actifs, paliers dégressifs, total. */
export default async function FirmBillingPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : monthOf(new Date().toISOString());
  const invoice = await apiTry<OrganizationInvoice>("/portal/org/billing", { query: { month } });
  return (
    <>
      <PageHeader
        title={t("firm.billing.title")}
        subtitle={t("firm.billing.subtitle")}
        actions={
          <form method="get" className="flex items-end gap-2">
            <label className="text-xs text-slate-500">
              {t("firm.billing.month")}
              <Input type="month" name="month" defaultValue={month} className="mt-1" />
            </label>
            <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              {t("common.apply")}
            </button>
          </form>
        }
      />
      <FirmNav />
      {!invoice.ok ? <ApiErrorNotice error={invoice.error} /> : null}
      {invoice.ok ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardTitle>{t("firm.billing.summary")}</CardTitle>
            <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              <div className="flex justify-between py-2"><dt className="text-slate-500">{t("firm.billing.month")}</dt><dd>{invoice.data.month}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-slate-500">{t("firm.org.plan")}</dt><dd>{invoice.data.planCode}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-slate-500">{t("firm.billing.activeDossiers")}</dt><dd className="tabular-nums">{invoice.data.activeDossiers}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-slate-500">{t("firm.billing.mode")}</dt><dd>{invoice.data.mode}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-slate-500">{t("firm.billing.unitPrice")}</dt><dd><Money value={invoice.data.unitPrice} currency={invoice.data.currency} showCurrency /></dd></div>
              <div className="flex justify-between py-2 font-semibold"><dt>{t("common.total")}</dt><dd><Money value={invoice.data.total} currency={invoice.data.currency} showCurrency /></dd></div>
            </dl>
          </Card>
          <Card className="lg:col-span-2">
            <CardTitle hint={t("firm.billing.tiersHint")}>{t("firm.billing.tiers")}</CardTitle>
            {invoice.data.lines.length === 0 ? <p className="text-sm text-slate-500">{t("firm.billing.noLines")}</p> : null}
            {invoice.data.lines.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("firm.billing.tier")}</th>
                    <th className="py-2 pr-3 text-right">{t("firm.billing.count")}</th>
                    <th className="py-2 pr-3 text-right">{t("firm.billing.unitPrice")}</th>
                    <th className="py-2 text-right">{t("common.amount")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {invoice.data.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="py-1.5 pr-3">{l.from} – {l.to}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{l.count}</td>
                      <td className="py-1.5 pr-3 text-right"><Money value={l.unitPrice} currency={invoice.data.currency} /></td>
                      <td className="py-1.5 text-right"><Money value={l.amount} currency={invoice.data.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Card>
        </div>
      ) : null}
    </>
  );
}
