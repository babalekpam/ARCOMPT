import Link from "next/link";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { addAmounts } from "@/lib/money";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocStatusBadge, salesStatusTone } from "@/components/invoicing/labels";
import { ListFilters } from "@/components/invoicing/ListFilters";
import { SALES_KINDS, SALES_STATUSES, type SalesDocument, type SalesKind, type SalesStatus } from "@/components/invoicing/types";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function InvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const kind = typeof sp.kind === "string" && (SALES_KINDS as string[]).includes(sp.kind) ? (sp.kind as SalesKind) : undefined;
  const status = typeof sp.status === "string" && (SALES_STATUSES as string[]).includes(sp.status) ? (sp.status as SalesStatus) : undefined;
  const res = await apiTry<SalesDocument[]>("/sales", { query: { kind, status, limit: 200 } });
  const docs = res.ok ? res.data : [];
  const currency = docs[0]?.currency ?? "XOF";
  const totals = docs.reduce(
    (acc, d) => ({ gross: addAmounts(acc.gross, d.totalGross), outstanding: addAmounts(acc.outstanding, d.kind === "INVOICE" ? d.outstanding : "0") }),
    { gross: "0", outstanding: "0" },
  );
  const counts = { QUOTE: 0, INVOICE: 0, CREDIT_NOTE: 0 } as Record<SalesKind, number>;
  for (const d of docs) counts[d.kind] += 1;

  return (
    <>
      <PageHeader
        title={t("invoicing.title")}
        subtitle={t("invoicing.subtitle")}
        actions={
          <>
            <LinkButton href="/invoices/new?kind=QUOTE" variant="secondary">
              {t("invoicing.newQuote")}
            </LinkButton>
            <LinkButton href="/invoices/new">{t("invoicing.newInvoice")}</LinkButton>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardTitle>{t("invoicing.totals.documents")}</CardTitle>
          <p className="text-2xl font-semibold">{docs.length}</p>
          <p className="text-xs text-slate-500">
            {t("invoicing.kind.QUOTE")} {counts.QUOTE} · {t("invoicing.kind.INVOICE")} {counts.INVOICE} · {t("invoicing.kind.CREDIT_NOTE")} {counts.CREDIT_NOTE}
          </p>
        </Card>
        <Card>
          <CardTitle>{t("invoicing.totals.gross")}</CardTitle>
          <p className="text-2xl font-semibold"><Money value={totals.gross} currency={currency} showCurrency /></p>
        </Card>
        <Card>
          <CardTitle>{t("invoicing.totals.outstanding")}</CardTitle>
          <p className="text-2xl font-semibold"><Money value={totals.outstanding} currency={currency} showCurrency /></p>
          <p className="text-xs text-slate-500">{t("invoicing.totals.outstandingHint")}</p>
        </Card>
      </div>
      <Card>
        <CardTitle action={<ListFilters fields={[{ name: "kind", label: t("invoicing.form.kind"), options: SALES_KINDS.map((k) => ({ value: k, label: t(`invoicing.kind.${k}`) })) }, { name: "status", label: t("common.status"), options: SALES_STATUSES.map((s) => ({ value: s, label: t(`invoicing.status.${s}`) })) }]} />}>
          {t("invoicing.list")}
        </CardTitle>
        {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
        {res.ok && docs.length === 0 ? <EmptyState title={t("invoicing.empty")} body={t("invoicing.emptyBody")} icon="▣" action={<LinkButton href="/invoices/new">{t("invoicing.newInvoice")}</LinkButton>} /> : null}
        {docs.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("invoicing.number")}</th>
                  <th className="py-2 pr-3">{t("invoicing.form.kind")}</th>
                  <th className="py-2 pr-3">{t("invoicing.form.customer")}</th>
                  <th className="py-2 pr-3">{t("common.date")}</th>
                  <th className="py-2 pr-3">{t("invoicing.form.dueDate")}</th>
                  <th className="py-2 pr-3">{t("common.status")}</th>
                  <th className="py-2 pr-3 text-right">{t("invoicing.form.gross")}</th>
                  <th className="py-2 text-right">{t("invoicing.outstanding")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {docs.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      <Link href={`/invoices/${d.id}`} className="underline-offset-2 hover:underline">
                        {d.number ?? t("invoicing.draftNumber")}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">{t(`invoicing.kind.${d.kind}`)}</td>
                    <td className="py-1.5 pr-3">{d.partnerName}</td>
                    <td className="py-1.5 pr-3">{formatDate(locale, d.issueDate)}</td>
                    <td className="py-1.5 pr-3">{formatDate(locale, d.dueDate)}</td>
                    <td className="py-1.5 pr-3"><DocStatusBadge tone={salesStatusTone(d.status)} label={t(`invoicing.status.${d.status}`)} /></td>
                    <td className="py-1.5 pr-3 text-right"><Money value={d.totalGross} currency={d.currency} /></td>
                    <td className="py-1.5 text-right"><Money value={d.kind === "INVOICE" ? d.outstanding : "0"} currency={d.currency} dashForZero /></td>
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
