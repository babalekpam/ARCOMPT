import Link from "next/link";
import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { addAmounts } from "@/lib/money";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocStatusBadge, paymentStatusTone, salesStatusTone } from "@/components/invoicing/labels";
import { loadInvoicingContext } from "@/components/invoicing/pack";
import { PdfDataView } from "@/components/invoicing/PdfDataView";
import { SalesDocumentActions } from "@/components/invoicing/SalesDocumentActions";
import { SalesDocumentForm } from "@/components/invoicing/SalesDocumentForm";
import { StatusTimeline } from "@/components/invoicing/StatusTimeline";
import type { OverdueInvoice, Payment, PaymentLink, SalesDocument } from "@/components/invoicing/types";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const res = await apiTry<SalesDocument>(`/sales/${id}`);
  if (!res.ok) {
    if ("status" in res.error && res.error.isNotFound) notFound();
    return (
      <>
        <PageHeader title={t("invoicing.title")} />
        <ApiErrorNotice error={res.error} />
      </>
    );
  }
  const doc = res.data;
  const [ctx, payments, links, overdue] = await Promise.all([
    loadInvoicingContext(),
    apiTry<Payment[]>("/payments", { query: { partnerId: doc.partnerId, limit: 200 } }),
    doc.kind === "INVOICE" ? apiTry<PaymentLink[]>(`/sales/${doc.id}/payment-links`) : Promise.resolve({ ok: true as const, data: [] as PaymentLink[] }),
    doc.kind === "INVOICE" && (doc.status === "SENT" || doc.status === "PARTIALLY_PAID") ? apiTry<OverdueInvoice[]>("/dunning/overdue") : Promise.resolve({ ok: true as const, data: [] as OverdueInvoice[] }),
  ]);
  const paymentRows = payments.ok ? payments.data.filter((p) => p.allocations.some((a) => a.salesDocumentId === doc.id)) : [];
  const overdueRow = overdue.ok ? overdue.data.find((o) => o.documentId === doc.id) : undefined;
  const editing = sp.edit === "1" && doc.status === "DRAFT";
  const title = `${t(`invoicing.kind.${doc.kind}`)} ${doc.number ?? t("invoicing.draftNumber")}`;

  return (
    <>
      <PageHeader
        title={title}
        subtitle={`${doc.partnerName} · ${formatDate(locale, doc.issueDate)}${doc.dueDate ? ` → ${formatDate(locale, doc.dueDate)}` : ""}`}
        actions={
          <>
            <DocStatusBadge tone={salesStatusTone(doc.status)} label={t(`invoicing.status.${doc.status}`)} />
            {doc.status === "DRAFT" && !editing ? (
              <LinkButton href={`/invoices/${doc.id}?edit=1`} variant="secondary" size="sm">
                {t("invoicing.edit")}
              </LinkButton>
            ) : null}
            <LinkButton href="/invoices" variant="ghost" size="sm">
              ← {t("invoicing.backToList")}
            </LinkButton>
          </>
        }
      />
      {editing ? (
        <Card className="mb-4">
          <CardTitle>{t("invoicing.edit")}</CardTitle>
          <SalesDocumentForm rates={ctx.rates} currency={doc.currency} existing={doc} packDraft={ctx.packDraft} />
        </Card>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardTitle>{t("common.actions")}</CardTitle>
            <SalesDocumentActions doc={doc} certifiedSystem={ctx.certifiedSystem} suggestedDunningLevel={overdueRow?.suggestedLevel} />
            {overdueRow ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t("invoicing.dunning.overdueHint", { days: overdueRow.daysOverdue, level: overdueRow.lastDunningLevel })}</p> : null}
          </Card>
          <Card>
            <CardTitle>{t("invoicing.form.lines")}</CardTitle>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">{t("common.label")}</th>
                    <th className="py-2 pr-3">{t("common.account")}</th>
                    <th className="py-2 pr-3 text-right">{t("invoicing.form.quantity")}</th>
                    <th className="py-2 pr-3 text-right">{t("invoicing.form.unitPrice")}</th>
                    <th className="py-2 pr-3 text-right">{t("invoicing.form.net")}</th>
                    <th className="py-2 pr-3">{t("invoicing.form.vat")}</th>
                    <th className="py-2 text-right">{t("invoicing.form.gross")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {doc.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="py-1.5 pr-3 text-xs text-slate-500">{l.lineNo}</td>
                      <td className="py-1.5 pr-3">{l.label}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{l.accountNumber}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-xs">{l.quantity}</td>
                      <td className="py-1.5 pr-3 text-right"><Money value={l.unitPrice} currency={doc.currency} /></td>
                      <td className="py-1.5 pr-3 text-right"><Money value={l.net} currency={doc.currency} /></td>
                      <td className="py-1.5 pr-3 text-xs">{l.vatCode ? `${l.vatCode} (${l.vatRate})` : "—"}</td>
                      <td className="py-1.5 text-right"><Money value={l.gross} currency={doc.currency} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 dark:border-slate-700">
                    <td colSpan={5} className="py-2 pr-3 text-right text-slate-500">{t("invoicing.form.net")}</td>
                    <td className="py-2 pr-3 text-right"><Money value={doc.totalNet} currency={doc.currency} /></td>
                    <td className="py-2 pr-3 text-right text-slate-500">{t("invoicing.form.vatTotal")}</td>
                    <td className="py-2 text-right"><Money value={doc.totalVat} currency={doc.currency} /></td>
                  </tr>
                  <tr className="font-semibold">
                    <td colSpan={7} className="py-1 pr-3 text-right">{t("invoicing.form.gross")}</td>
                    <td className="py-1 text-right"><Money value={doc.totalGross} currency={doc.currency} showCurrency /></td>
                  </tr>
                  {doc.kind === "INVOICE" ? (
                    <>
                      <tr>
                        <td colSpan={7} className="py-1 pr-3 text-right text-slate-500">{t("invoicing.paid")}</td>
                        <td className="py-1 text-right"><Money value={doc.paidAmount} currency={doc.currency} dashForZero /></td>
                      </tr>
                      <tr>
                        <td colSpan={7} className="py-1 pr-3 text-right text-slate-500">{t("invoicing.credited")}</td>
                        <td className="py-1 text-right"><Money value={doc.creditedAmount} currency={doc.currency} dashForZero /></td>
                      </tr>
                      <tr className="font-semibold">
                        <td colSpan={7} className="py-1 pr-3 text-right">{t("invoicing.outstanding")}</td>
                        <td className="py-1 text-right"><Money value={doc.outstanding} currency={doc.currency} showCurrency /></td>
                      </tr>
                    </>
                  ) : null}
                </tfoot>
              </table>
            </div>
            {doc.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{doc.notes}</p> : null}
          </Card>
          <Card>
            <CardTitle hint={t("invoicing.payments.hint")}>{t("invoicing.payments.title")}</CardTitle>
            {!payments.ok ? <ApiErrorNotice error={payments.error} /> : null}
            {payments.ok && paymentRows.length === 0 ? <p className="text-sm text-slate-500">{t("invoicing.payments.none")}</p> : null}
            {paymentRows.length > 0 ? (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {paymentRows.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <Link href={`/payments?q=${p.id}`} className="font-mono text-xs underline-offset-2 hover:underline">{p.number}</Link>
                      <span className="ml-2 text-xs text-slate-500">{formatDate(locale, p.date)} · {t(`invoicing.method.${p.method}`)} · {p.treasuryAccountNumber}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <DocStatusBadge tone={paymentStatusTone(p.status)} label={t(`invoicing.paymentStatus.${p.status}`)} />
                      <Money value={addAmounts("0", ...p.allocations.filter((a) => a.salesDocumentId === doc.id).map((a) => a.amount))} currency={p.currency} className="font-semibold" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {links.ok && links.data.length > 0 ? (
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("invoicing.links.title")}</p>
                <ul className="space-y-1 text-xs">
                  {links.data.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2">
                      <Badge tone={l.status === "PAID" ? "success" : l.status === "PENDING" ? "warning" : "danger"}>{t(`invoicing.links.status.${l.status}`)}</Badge>
                      <span>{l.provider}</span>
                      <a href={l.url} target="_blank" rel="noreferrer" className="break-all underline">{l.url}</a>
                      <Money value={l.amount} currency={l.currency} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardTitle>{t("invoicing.timeline.title")}</CardTitle>
            <StatusTimeline doc={doc} payments={payments.ok ? payments.data : []} t={t} locale={locale} />
          </Card>
          <Card>
            <CardTitle hint={t("invoicing.pdf.hint")}>{t("invoicing.pdf.title")}</CardTitle>
            <PdfDataView id={doc.id} />
          </Card>
          {doc.sourceDocumentId ? (
            <Card>
              <CardTitle>{t("invoicing.source")}</CardTitle>
              <Link href={`/invoices/${doc.sourceDocumentId}`} className="font-mono text-xs underline">{doc.sourceDocumentId}</Link>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
