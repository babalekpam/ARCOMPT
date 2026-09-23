// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { AccountForm } from "@/components/treasury/AccountForm";
import { CashCountForm } from "@/components/treasury/CashCountForm";
import { ReconciliationCard } from "@/components/treasury/ReconciliationCard";
import { StatementImportForm } from "@/components/treasury/StatementImportForm";
import { TransactionsPanel } from "@/components/treasury/TransactionsPanel";
import type { BankStatement, ReconciliationReport, TreasuryAccount } from "@/components/treasury/types";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

/** Fiche d'un compte de trésorerie : relevés, import, lignes et rapprochement, comptage (caisse), modification. */
export default async function TreasuryAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const res = await apiTry<TreasuryAccount>(`/treasury/accounts/${id}`);
  if (!res.ok) {
    if ("status" in res.error && res.error.isNotFound) notFound();
    return (
      <>
        <PageHeader title={t("treasury.title")} />
        <ApiErrorNotice error={res.error} />
      </>
    );
  }
  const account = res.data;
  const [statements, reconciliation] = await Promise.all([apiTry<BankStatement[]>(`/treasury/accounts/${id}/statements`), apiTry<ReconciliationReport>(`/treasury/accounts/${id}/reconciliation`)]);
  const list = statements.ok ? statements.data : [];
  const statementId = typeof sp.statement === "string" && list.some((s) => s.id === sp.statement) ? sp.statement : undefined;
  const editing = sp.edit === "1";

  return (
    <>
      <PageHeader
        title={account.label}
        subtitle={`${t(`treasury.kind.${account.kind}`)} · ${account.accountNumber} · ${account.currency}${account.bankName ? ` · ${account.bankName}` : ""}${account.mmOperator ? ` · ${account.mmOperator}` : ""}`}
        actions={
          <>
            {!account.active ? <Badge tone="neutral">{t("treasury.account.inactive")}</Badge> : null}
            <LinkButton href={editing ? `/treasury/${id}` : `/treasury/${id}?edit=1`} variant="secondary" size="sm">
              {editing ? t("common.close") : t("treasury.account.edit")}
            </LinkButton>
            <LinkButton href="/treasury" variant="ghost" size="sm">
              ← {t("treasury.title")}
            </LinkButton>
          </>
        }
      />
      {editing ? (
        <Card className="mb-4">
          <CardTitle>{t("treasury.account.edit")}</CardTitle>
          <AccountForm existing={account} currency={account.currency} />
        </Card>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardTitle hint={t("treasury.transactions.hint")}>{t("treasury.transactions.title")}</CardTitle>
            {!statements.ok ? <ApiErrorNotice error={statements.error} /> : null}
            <TransactionsPanel accountId={id} statements={list} currency={account.currency} initialStatementId={statementId} />
          </Card>
          <Card>
            <CardTitle hint={t("treasury.import.hint")}>{t("treasury.import.title")}</CardTitle>
            <StatementImportForm accountId={id} accountKind={account.kind} />
          </Card>
          {account.kind === "CASH" ? (
            <Card>
              <CardTitle hint={t("treasury.cash.hint")}>{t("treasury.cash.title")}</CardTitle>
              <CashCountForm accountId={id} currency={account.currency} />
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardTitle>{t("treasury.reconciliation.title")}</CardTitle>
            {!reconciliation.ok ? <ApiErrorNotice error={reconciliation.error} /> : <ReconciliationCard report={reconciliation.data} t={t} locale={locale} />}
          </Card>
          <Card>
            <CardTitle>{t("treasury.statements.title")}</CardTitle>
            {list.length === 0 ? <p className="text-sm text-slate-500">{t("treasury.statements.none")}</p> : null}
            {list.length > 0 ? (
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {list.map((s) => (
                  <li key={s.id} className="py-2">
                    <a href={`/treasury/${id}?statement=${s.id}`} className="font-medium underline-offset-2 hover:underline">
                      {formatDate(locale, s.periodFrom)} → {formatDate(locale, s.periodTo)}
                    </a>
                    <div className="text-xs text-slate-500">
                      <Badge tone="neutral">{s.source}</Badge>
                      <span className="ml-2">{t("treasury.statements.opening")} <Money value={s.openingBalance} currency={account.currency} colorSign /></span>
                      <span className="ml-2">{t("treasury.statements.closing")} <Money value={s.closingBalance} currency={account.currency} colorSign /></span>
                    </div>
                    <div className="text-[11px] text-slate-400">{t("treasury.statements.importedAt", { date: formatDate(locale, s.importedAt.slice(0, 10)) })}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
