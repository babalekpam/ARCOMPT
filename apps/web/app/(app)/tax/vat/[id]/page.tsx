import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { loadCompanyPack } from "@/components/packs/context";
import { packLabel } from "@/components/packs/helpers";
import { PackNotice } from "@/components/packs/PackNotice";
import { parseVatComputation, returnTone } from "@/components/tax/helpers";
import type { TaxReturn, VatCodeAmount } from "@/components/tax/types";
import { VatReturnActions } from "@/components/tax/VatReturnActions";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function VatReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const res = await apiTry<TaxReturn>(`/tax/vat/returns/${id}`);
  if (!res.ok && "status" in res.error && res.error.isNotFound) notFound();
  const comp = res.ok ? parseVatComputation(res.data.data) : null;
  // `official` est porté par la déclaration elle-même : il dit avec quel pack
  // elle a été calculée, ce qui reste vrai même si le pack est publié depuis.
  // Le pack n'est chargé que pour le nommer.
  const pack = res.ok && res.data.official === false ? await loadCompanyPack() : null;
  const packName = pack ? (pack.ref ? packLabel(pack.ref) : pack.packCode.toUpperCase()) : "";

  return (
    <>
      <PageHeader
        title={t("tax.vat.detailTitle")}
        subtitle={res.ok ? `${formatDate(locale, res.data.periodFrom)} → ${formatDate(locale, res.data.periodTo)}` : undefined}
        actions={
          <LinkButton href="/tax" variant="secondary" size="sm">
            {t("tax.back")}
          </LinkButton>
        }
      />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      {res.ok ? (
        <>
          {res.data.official === false ? <PackNotice surface="vatReturn" pack={packName} className="mb-4" /> : null}
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone={returnTone(res.data.status)}>{t(`tax.returnStatus.${res.data.status}`)}</Badge>
            {res.data.entryId ? (
              <span>
                · {t("tax.vat.entry")} <span className="font-mono">{res.data.entryId}</span>
              </span>
            ) : null}
            {res.data.paymentEntryId ? (
              <span>
                · {t("tax.vat.paymentEntry")} <span className="font-mono">{res.data.paymentEntryId}</span>
              </span>
            ) : null}
            {res.data.filingReference ? (
              <span>
                · {t("tax.filingReference")} {res.data.filingReference} ({formatDate(locale, res.data.filedAt)})
              </span>
            ) : null}
          </div>
          {comp ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label={t("tax.vat.totalCollected")} value={comp.totalCollected} currency={currency} />
              <Kpi label={t("tax.vat.totalDeductible")} value={comp.totalDeductible} currency={currency} />
              <Kpi label={t("tax.vat.previousCredit")} value={comp.previousCredit} currency={currency} />
              <Kpi label={comp.amountDue !== "0.0000" || comp.creditCarried === "0.0000" ? t("tax.amountDue") : t("tax.vat.creditCarried")} value={comp.amountDue !== "0.0000" || comp.creditCarried === "0.0000" ? comp.amountDue : comp.creditCarried} currency={currency} strong />
            </div>
          ) : (
            <Alert tone="warning">{t("tax.vat.noDetail")}</Alert>
          )}
          <Card className="mt-4">
            <CardTitle hint={t("tax.vat.actionsHint")}>{t("common.actions")}</CardTitle>
            <VatReturnActions taxReturn={res.data} />
          </Card>
          {comp ? (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardTitle>{t("tax.vat.collected")}</CardTitle>
                <CodeTable rows={comp.collected} total={comp.totalCollected} currency={currency} t={t} />
              </Card>
              <Card>
                <CardTitle>{t("tax.vat.deductible")}</CardTitle>
                <CodeTable rows={comp.deductible} total={comp.totalDeductible} currency={currency} t={t} />
              </Card>
            </div>
          ) : null}
          {comp ? (
            <Card className="mt-4">
              <CardTitle>{t("tax.vat.liquidation")}</CardTitle>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label={t("tax.vat.net")} value={comp.net} currency={currency} />
                <Stat label={t("tax.vat.previousCredit")} value={comp.previousCredit} currency={currency} />
                <Stat label={t("tax.amountDue")} value={comp.amountDue} currency={currency} />
                <Stat label={t("tax.vat.creditCarried")} value={comp.creditCarried} currency={currency} />
              </dl>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function CodeTable({ rows, total, currency, t }: { rows: VatCodeAmount[]; total: string; currency: string; t: (k: string) => string }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{t("common.empty")}</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className="py-1 text-left">{t("tax.vat.code")}</th>
          <th className="py-1 text-right">{t("tax.vat.rate")}</th>
          <th className="py-1 text-right">{t("tax.vat.base")}</th>
          <th className="py-1 text-right">{t("common.amount")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((r) => (
          <tr key={r.vatCode}>
            <td className="py-1 font-mono text-xs">{r.vatCode}</td>
            <td className="py-1 text-right font-mono text-xs text-slate-500">{r.rate ?? "—"}</td>
            <td className="py-1 text-right">{r.base ? <Money value={r.base} currency={currency} /> : "—"}</td>
            <td className="py-1 text-right"><Money value={r.amount} currency={currency} /></td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-slate-300 font-semibold dark:border-slate-700">
          <td className="py-1" colSpan={3}>{t("common.total")}</td>
          <td className="py-1 text-right"><Money value={total} currency={currency} /></td>
        </tr>
      </tfoot>
    </table>
  );
}

function Kpi({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <Card as="div" className={strong ? "border-slate-900 dark:border-slate-100" : ""}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        <Money value={value} currency={currency} showCurrency />
      </p>
    </Card>
  );
}

function Stat({ label, value, currency }: { label: string; value: string; currency: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="font-medium">
        <Money value={value} currency={currency} colorSign />
      </dd>
    </div>
  );
}
