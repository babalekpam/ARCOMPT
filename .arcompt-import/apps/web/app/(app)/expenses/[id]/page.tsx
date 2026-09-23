// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { addAmounts } from "@/lib/money";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocStatusBadge, paymentStatusTone, purchaseStatusTone } from "@/components/invoicing/labels";
import { loadInvoicingContext } from "@/components/invoicing/pack";
import { PurchaseDocumentActions } from "@/components/invoicing/PurchaseDocumentActions";
import { PurchaseDocumentForm } from "@/components/invoicing/PurchaseDocumentForm";
import { StatusTimeline } from "@/components/invoicing/StatusTimeline";
import type { Payment, PurchaseDocument } from "@/components/invoicing/types";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function ExpenseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const res = await apiTry<PurchaseDocument>(`/purchases/${id}`);
  if (!res.ok) {
    if ("status" in res.error && res.error.isNotFound) notFound();
    return (
      <>
        <PageHeader title={t("invoicing.expense.title")} />
        <ApiErrorNotice error={res.error} />
      </>
    );
  }
  const doc = res.data;
  const [ctx, payments] = await Promise.all([loadInvoicingContext(), apiTry<Payment[]>("/payments", { query: { partnerId: doc.partnerId, limit: 200 } })]);
  const paymentRows = payments.ok ? payments.data.filter((p) => p.allocations.some((a) => a.purchaseDocumentId === doc.id)) : [];
  const editing = sp.edit === "1" && doc.status === "DRAFT";

  return (
    <>
      <PageHeader
        title={`${t(`invoicing.purchaseKind.${doc.kind}`)} ${doc.number ?? t("invoicing.draftNumber")}`}
        subtitle={`${doc.partnerName} · ${formatDate(locale, doc.issueDate)}${doc.reference ? ` · ${doc.reference}` : ""}`}
        actions={
          <>
            <DocStatusBadge tone={purchaseStatusTone(doc.status)} label={t(`invoicing.purchaseStatus.${doc.status}`)} />
            {doc.status === "DRAFT" && !editing ? (
              <LinkButton href={`/expenses/${doc.id}?edit=1`} variant="secondary" size="sm">
                {t("invoicing.edit")}
              </LinkButton>
            ) : null}
            <LinkButton href="/expenses" variant="ghost" size="sm">
              ← {t("invoicing.backToList")}
            </LinkButton>
          </>
        }
      />
      {editing ? (
        <Card className="mb-4">
          <CardTitle>{t("invoicing.edit")}</CardTitle>
          <PurchaseDocumentForm rates={ctx.rates} currency={doc.currency} existing={doc} packDraft={ctx.packDraft} />
        </Card>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardTitle>{t("common.actions")}</CardTitle>
            <PurchaseDocumentActions doc={doc} />
          </Card>
          <Card>
            <CardTitle>{t("invoicing.form.lines")}</CardTitle>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">{t("common.account")}</th>
                    <th className="py-2 pr-3">{t("common.label")}</th>
                    <th className="py-2 pr-3 text-right">{t("invoicing.form.net")}</th>
                    <th className="py-2 pr-3">{t("invoicing.form.vat")}</th>
                    <th className="py-2 pr-3 text-right">{t("invoicing.expense.deductibleVat")}</th>
                    <th className="py-2 text-right">{t("invoicing.form.gross")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {doc.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="py-1.5 pr-3 text-xs text-slate-500">{l.lineNo}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{l.accountNumber}</td>
                      <td className="py-1.5 pr-3">{l.label}</td>
                      <td className="py-1.5 pr-3 text-right"><Money value={l.net} currency={doc.currency} /></td>
                      <td className="py-1.5 pr-3 text-xs">{l.vatCode ? `${l.vatCode} (${l.vatRate})` : "—"}</td>
                      <td className="py-1.5 pr-3 text-right"><Money value={l.vat} currency={doc.currency} dashForZero /></td>
                      <td className="py-1.5 text-right"><Money value={l.gross} currency={doc.currency} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 dark:border-slate-700">
                    <td colSpan={3} className="py-2 pr-3 text-right text-slate-500">{t("invoicing.form.net")}</td>
                    <td className="py-2 pr-3 text-right"><Money value={doc.totalNet} currency={doc.currency} /></td>
                    <td className="py-2 pr-3 text-right text-slate-500">{t("invoicing.form.vatTotal")}</td>
                    <td className="py-2 pr-3 text-right"><Money value={doc.totalVat} currency={doc.currency} /></td>
                    <td className="py-2 text-right font-semibold"><Money value={doc.totalGross} currency={doc.currency} showCurrency /></td>
                  </tr>
                  <tr>
                    <td colSpan={6} className="py-1 pr-3 text-right text-slate-500">{t("invoicing.paid")}</td>
                    <td className="py-1 text-right"><Money value={doc.paidAmount} currency={doc.currency} dashForZero /></td>
                  </tr>
                  <tr className="font-semibold">
                    <td colSpan={6} className="py-1 pr-3 text-right">{t("invoicing.outstanding")}</td>
                    <td className="py-1 text-right"><Money value={doc.outstanding} currency={doc.currency} /></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {doc.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{doc.notes}</p> : null}
            {doc.documentId ? (
              <p className="mt-2 text-xs text-slate-500">
                {t("invoicing.expense.linkedDocument")}{" "}
                <Link href={`/documents/${doc.documentId}`} className="font-mono underline">{doc.documentId}</Link>
              </p>
            ) : null}
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
                      <span className="font-mono text-xs">{p.number}</span>
                      <span className="ml-2 text-xs text-slate-500">{formatDate(locale, p.date)} · {t(`invoicing.method.${p.method}`)} · {p.treasuryAccountNumber}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <DocStatusBadge tone={paymentStatusTone(p.status)} label={t(`invoicing.paymentStatus.${p.status}`)} />
                      <Money value={addAmounts("0", ...p.allocations.filter((a) => a.purchaseDocumentId === doc.id).map((a) => a.amount))} currency={p.currency} className="font-semibold" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardTitle>{t("invoicing.timeline.title")}</CardTitle>
            <StatusTimeline doc={doc} payments={payments.ok ? payments.data : []} t={t} locale={locale} />
          </Card>
          {doc.sourceDocumentId ? (
            <Card>
              <CardTitle>{t("invoicing.source")}</CardTitle>
              <Link href={`/expenses/${doc.sourceDocumentId}`} className="font-mono text-xs underline">{doc.sourceDocumentId}</Link>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
