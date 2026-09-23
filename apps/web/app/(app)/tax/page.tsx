import Link from "next/link";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { loadCompanyPack } from "@/components/packs/context";
import { PackNotice } from "@/components/packs/PackNotice";
import { SubNav } from "@/components/payroll/SubNav";
import { returnTone } from "@/components/tax/helpers";
import { TAX_NAV } from "@/components/tax/nav";
import type { TaxReturn } from "@/components/tax/types";
import { VatComputeForm } from "@/components/tax/VatComputeForm";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function TaxPage() {
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const [returns, pack] = await Promise.all([apiTry<TaxReturn[]>("/tax/vat/returns"), loadCompanyPack()]);

  return (
    <>
      <PageHeader title={t("tax.title")} subtitle={t("tax.subtitle")} />
      <SubNav items={TAX_NAV} />
      {/* Une seule mention pour l'écran : la position de la période se calcule,
          mais aucune déclaration n'en sortira tant que le pack est un brouillon. */}
      {pack.draft ? <PackNotice surface="vat" pack={pack.draft.pack} className="mb-4" /> : null}
      <Card>
        <CardTitle hint={t("tax.vat.computeHint")}>{t("tax.vat.newReturn")}</CardTitle>
        <VatComputeForm />
      </Card>
      <Card className="mt-4">
        <CardTitle hint={t("tax.vat.listHint")}>{t("tax.vat.list")}</CardTitle>
        {!returns.ok ? <ApiErrorNotice error={returns.error} /> : null}
        {returns.ok && returns.data.length === 0 ? <p className="text-sm text-slate-500">{t("tax.vat.empty")}</p> : null}
        {returns.ok && returns.data.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("tax.period")}</th>
                  <th className="py-2 pr-3">{t("common.status")}</th>
                  <th className="py-2 pr-3 text-right">{t("tax.amountDue")}</th>
                  <th className="py-2 pr-3">{t("tax.filingReference")}</th>
                  <th className="py-2">{t("tax.updatedAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {returns.data.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-3">
                      <Link href={`/tax/vat/${r.id}`} className="font-medium underline-offset-2 hover:underline">
                        {formatDate(locale, r.periodFrom)} → {formatDate(locale, r.periodTo)}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={returnTone(r.status)}>{t(`tax.returnStatus.${r.status}`)}</Badge>
                      {r.official === false ? <Badge tone="warning" className="ml-1">{t("tax.vat.nonOfficial")}</Badge> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right"><Money value={r.amountDue} currency={currency} dashForZero /></td>
                    <td className="py-1.5 pr-3 text-xs text-slate-500">{r.filingReference ?? "—"}</td>
                    <td className="py-1.5 text-xs text-slate-500">{formatDate(locale, r.updatedAt)}</td>
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
