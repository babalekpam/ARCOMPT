// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { AgedTable } from "@/components/invoicing/AgedTable";
import { DocStatusBadge, paymentStatusTone } from "@/components/invoicing/labels";
import { ListFilters } from "@/components/invoicing/ListFilters";
import { OverdueList } from "@/components/invoicing/OverdueList";
import { PaymentActions } from "@/components/invoicing/PaymentActions";
import { PAYMENT_KINDS, PAYMENT_STATUSES, type AgedReport, type OverdueInvoice, type Payment, type PaymentKind, type PaymentStatus } from "@/components/invoicing/types";
import { Alert } from "@/components/ui/Alert";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

const TABS = ["list", "receivables", "payables", "dunning"] as const;
type Tab = (typeof TABS)[number];

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const tab: Tab = typeof sp.tab === "string" && (TABS as readonly string[]).includes(sp.tab) ? (sp.tab as Tab) : "list";
  const kind = typeof sp.kind === "string" && (PAYMENT_KINDS as string[]).includes(sp.kind) ? (sp.kind as PaymentKind) : undefined;
  const status = typeof sp.status === "string" && (PAYMENT_STATUSES as string[]).includes(sp.status) ? (sp.status as PaymentStatus) : undefined;
  const asOf = typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : undefined;
  const [payments, pending] = await Promise.all([
    tab === "list" ? apiTry<Payment[]>("/payments", { query: { kind, status, limit: 200 } }) : Promise.resolve(null),
    apiTry<Payment[]>("/payments", { query: { status: "PENDING_APPROVAL", limit: 50 } }),
  ]);
  const aged = tab === "receivables" ? await apiTry<AgedReport>("/receivables/aged", { query: { asOf } }) : tab === "payables" ? await apiTry<AgedReport>("/payables/aged", { query: { asOf } }) : null;
  const overdue = tab === "dunning" ? await apiTry<OverdueInvoice[]>("/dunning/overdue", { query: { asOf } }) : null;
  const pendingCount = pending.ok ? pending.data.length : 0;
  const tabHref = (x: Tab) => `/payments?tab=${x}`;

  return (
    <>
      <PageHeader title={t("invoicing.payments.pageTitle")} subtitle={t("invoicing.payments.pageSubtitle")} actions={<LinkButton href="/payments/new">{t("invoicing.payments.new")}</LinkButton>} />
      {pendingCount > 0 && tab !== "list" ? (
        <Alert tone="warning" className="mb-4">
          {t("invoicing.payments.pendingNotice", { count: pendingCount })}{" "}
          <Link href="/payments?tab=list&status=PENDING_APPROVAL" className="underline">{t("invoicing.payments.pendingLink")}</Link>
        </Alert>
      ) : null}
      <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label={t("invoicing.payments.tabs")}>
        {TABS.map((x) => (
          <Link key={x} href={tabHref(x)} aria-current={x === tab ? "page" : undefined} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${x === tab ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
            {t(`invoicing.payments.tab.${x}`)}
            {x === "list" && pendingCount > 0 ? <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{pendingCount}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "list" && payments ? (
        <Card>
          <CardTitle action={<ListFilters fields={[{ name: "kind", label: t("invoicing.payments.kind"), options: PAYMENT_KINDS.map((k) => ({ value: k, label: t(`invoicing.paymentKind.${k}`) })) }, { name: "status", label: t("common.status"), options: PAYMENT_STATUSES.map((s) => ({ value: s, label: t(`invoicing.paymentStatus.${s}`) })) }]} />}>
            {t("invoicing.payments.list")}
          </CardTitle>
          {!payments.ok ? <ApiErrorNotice error={payments.error} /> : null}
          {payments.ok && payments.data.length === 0 ? <EmptyState title={t("invoicing.payments.empty")} body={t("invoicing.payments.emptyBody")} icon="◎" action={<LinkButton href="/payments/new">{t("invoicing.payments.new")}</LinkButton>} /> : null}
          {payments.ok && payments.data.length > 0 ? (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("invoicing.number")}</th>
                    <th className="py-2 pr-3">{t("common.date")}</th>
                    <th className="py-2 pr-3">{t("invoicing.payments.kind")}</th>
                    <th className="py-2 pr-3">{t("invoicing.payments.method")}</th>
                    <th className="py-2 pr-3">{t("common.account")}</th>
                    <th className="py-2 pr-3">{t("common.status")}</th>
                    <th className="py-2 pr-3 text-right">{t("common.amount")}</th>
                    <th className="py-2 pr-3 text-right">{t("invoicing.payments.allocated")}</th>
                    <th className="py-2">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {payments.data.map((p) => (
                    <tr key={p.id} className={sp.q === p.id ? "bg-amber-50 dark:bg-amber-950/30" : ""}>
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {p.number}
                        {p.reference ? <span className="ml-1 text-slate-500">· {p.reference}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3">{formatDate(locale, p.date)}</td>
                      <td className="py-1.5 pr-3">{t(`invoicing.paymentKind.${p.kind}`)}</td>
                      <td className="py-1.5 pr-3">{t(`invoicing.method.${p.method}`)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{p.treasuryAccountNumber}</td>
                      <td className="py-1.5 pr-3">
                        <DocStatusBadge tone={paymentStatusTone(p.status)} label={t(`invoicing.paymentStatus.${p.status}`)} />
                        {p.reviewReason ? <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">{p.reviewReason}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 text-right"><Money value={p.amount} currency={p.currency} /></td>
                      <td className="py-1.5 pr-3 text-right"><Money value={p.allocated} currency={p.currency} dashForZero /></td>
                      <td className="py-1.5">
                        <PaymentActions payment={p} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      ) : null}

      {(tab === "receivables" || tab === "payables") && aged ? (
        <Card>
          <CardTitle hint={aged.ok ? t("invoicing.aged.asOf", { date: formatDate(locale, aged.data.asOf) }) : undefined}>{tab === "receivables" ? t("invoicing.aged.receivables") : t("invoicing.aged.payables")}</CardTitle>
          {!aged.ok ? <ApiErrorNotice error={aged.error} /> : <AgedTable report={aged.data} t={t} />}
        </Card>
      ) : null}

      {tab === "dunning" && overdue ? (
        <Card>
          <CardTitle hint={t("invoicing.dunning.hint")}>{t("invoicing.dunning.title")}</CardTitle>
          {!overdue.ok ? <ApiErrorNotice error={overdue.error} /> : <OverdueList rows={overdue.data} t={t} locale={locale} />}
        </Card>
      ) : null}
    </>
  );
}
