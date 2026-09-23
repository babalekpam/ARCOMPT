// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { addAmounts } from "@/lib/money";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocStatusBadge, purchaseStatusTone } from "@/components/invoicing/labels";
import { ListFilters } from "@/components/invoicing/ListFilters";
import { PURCHASE_KINDS, PURCHASE_STATUSES, type PurchaseDocument, type PurchaseKind, type PurchaseStatus } from "@/components/invoicing/types";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function ExpensesPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const kind = typeof sp.kind === "string" && (PURCHASE_KINDS as string[]).includes(sp.kind) ? (sp.kind as PurchaseKind) : undefined;
  const status = typeof sp.status === "string" && (PURCHASE_STATUSES as string[]).includes(sp.status) ? (sp.status as PurchaseStatus) : undefined;
  const res = await apiTry<PurchaseDocument[]>("/purchases", { query: { kind, status, limit: 200 } });
  const docs = res.ok ? res.data : [];
  const currency = docs[0]?.currency ?? "XOF";
  const totals = docs.reduce((acc, d) => ({ gross: addAmounts(acc.gross, d.totalGross), outstanding: addAmounts(acc.outstanding, d.kind === "SUPPLIER_CREDIT_NOTE" ? "0" : d.outstanding) }), { gross: "0", outstanding: "0" });

  return (
    <>
      <PageHeader
        title={t("invoicing.expense.title")}
        subtitle={t("invoicing.expense.subtitle")}
        actions={
          <>
            <LinkButton href="/documents/upload" variant="secondary">
              {t("invoicing.expense.capture")}
            </LinkButton>
            <LinkButton href="/expenses/new?kind=EXPENSE_CLAIM" variant="secondary">
              {t("invoicing.expense.newClaim")}
            </LinkButton>
            <LinkButton href="/expenses/new">{t("invoicing.expense.newInvoice")}</LinkButton>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardTitle>{t("invoicing.totals.documents")}</CardTitle>
          <p className="text-2xl font-semibold">{docs.length}</p>
        </Card>
        <Card>
          <CardTitle>{t("invoicing.totals.gross")}</CardTitle>
          <p className="text-2xl font-semibold"><Money value={totals.gross} currency={currency} showCurrency /></p>
        </Card>
        <Card>
          <CardTitle>{t("invoicing.expense.toPay")}</CardTitle>
          <p className="text-2xl font-semibold"><Money value={totals.outstanding} currency={currency} showCurrency /></p>
        </Card>
      </div>
      <Card>
        <CardTitle action={<ListFilters fields={[{ name: "kind", label: t("invoicing.form.kind"), options: PURCHASE_KINDS.map((k) => ({ value: k, label: t(`invoicing.purchaseKind.${k}`) })) }, { name: "status", label: t("common.status"), options: PURCHASE_STATUSES.map((s) => ({ value: s, label: t(`invoicing.purchaseStatus.${s}`) })) }]} />}>
          {t("invoicing.list")}
        </CardTitle>
        {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
        {res.ok && docs.length === 0 ? <EmptyState title={t("invoicing.expense.empty")} body={t("invoicing.expense.emptyBody")} icon="▧" action={<LinkButton href="/expenses/new">{t("invoicing.expense.newInvoice")}</LinkButton>} /> : null}
        {docs.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("invoicing.number")}</th>
                  <th className="py-2 pr-3">{t("invoicing.form.kind")}</th>
                  <th className="py-2 pr-3">{t("invoicing.expense.partner")}</th>
                  <th className="py-2 pr-3">{t("invoicing.expense.reference")}</th>
                  <th className="py-2 pr-3">{t("common.date")}</th>
                  <th className="py-2 pr-3">{t("common.status")}</th>
                  <th className="py-2 pr-3 text-right">{t("invoicing.form.gross")}</th>
                  <th className="py-2 text-right">{t("invoicing.outstanding")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {docs.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      <Link href={`/expenses/${d.id}`} className="underline-offset-2 hover:underline">
                        {d.number ?? t("invoicing.draftNumber")}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">{t(`invoicing.purchaseKind.${d.kind}`)}</td>
                    <td className="py-1.5 pr-3">{d.partnerName}</td>
                    <td className="py-1.5 pr-3 text-xs">{d.reference ?? "—"}</td>
                    <td className="py-1.5 pr-3">{formatDate(locale, d.issueDate)}</td>
                    <td className="py-1.5 pr-3"><DocStatusBadge tone={purchaseStatusTone(d.status)} label={t(`invoicing.purchaseStatus.${d.status}`)} /></td>
                    <td className="py-1.5 pr-3 text-right"><Money value={d.totalGross} currency={d.currency} /></td>
                    <td className="py-1.5 text-right"><Money value={d.outstanding} currency={d.currency} dashForZero /></td>
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
