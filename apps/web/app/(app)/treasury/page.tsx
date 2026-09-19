import Link from "next/link";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { getT } from "@/lib/i18n-server";
import { addAmounts } from "@/lib/money";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { AccountForm } from "@/components/treasury/AccountForm";
import type { ReconciliationReport, TreasuryAccount } from "@/components/treasury/types";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

/** Vue d'ensemble des comptes de trésorerie : nature, solde comptable et état du rapprochement. */
export default async function TreasuryPage() {
  const { t } = await getT();
  const currency = config.defaultCurrency();
  const res = await apiTry<TreasuryAccount[]>("/treasury/accounts", { query: { includeInactive: "true" } });
  const accounts = res.ok ? res.data : [];
  const reports = await Promise.all(accounts.map((a) => apiTry<ReconciliationReport>(`/treasury/accounts/${a.id}/reconciliation`)));
  const byId = new Map(accounts.map((a, i) => [a.id, reports[i]] as const));
  let total = "0";
  for (const r of reports) if (r.ok && r.data.account.active) total = addAmounts(total, r.data.bookBalance);
  const kindTone = (k: TreasuryAccount["kind"]) => (k === "BANK" ? "info" : k === "CASH" ? "warning" : "success");

  return (
    <>
      <PageHeader
        title={t("treasury.title")}
        subtitle={t("treasury.subtitle")}
        actions={
          <LinkButton href="/treasury/forecast" variant="secondary">
            {t("treasury.forecast.title")}
          </LinkButton>
        }
      />
      {!res.ok ? <ApiErrorNotice error={res.error} /> : null}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardTitle>{t("treasury.overview.total")}</CardTitle>
          <p className="text-2xl font-semibold"><Money value={total} currency={currency} colorSign showCurrency /></p>
          <p className="text-xs text-slate-500">{t("treasury.overview.totalHint")}</p>
        </Card>
        <Card>
          <CardTitle>{t("treasury.overview.accounts")}</CardTitle>
          <p className="text-2xl font-semibold">{accounts.filter((a) => a.active).length}</p>
          <p className="text-xs text-slate-500">
            {(["BANK", "CASH", "MOBILE_MONEY"] as const).map((k) => `${t(`treasury.kind.${k}`)} ${accounts.filter((a) => a.active && a.kind === k).length}`).join(" · ")}
          </p>
        </Card>
        <Card>
          <CardTitle>{t("treasury.overview.unreconciled")}</CardTitle>
          <p className="text-2xl font-semibold">{reports.filter((r) => r.ok && !r.data.balanced).length}</p>
          <p className="text-xs text-slate-500">{t("treasury.overview.unreconciledHint")}</p>
        </Card>
      </div>
      <Card className="mb-4">
        <CardTitle hint={t("treasury.account.newHint")}>{t("treasury.account.new")}</CardTitle>
        <AccountForm currency={currency} />
      </Card>
      <Card>
        <CardTitle>{t("treasury.overview.list")}</CardTitle>
        {res.ok && accounts.length === 0 ? <EmptyState title={t("treasury.overview.empty")} body={t("treasury.overview.emptyBody")} icon="◈" /> : null}
        {accounts.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("common.label")}</th>
                  <th className="py-2 pr-3">{t("treasury.account.kind")}</th>
                  <th className="py-2 pr-3">{t("common.account")}</th>
                  <th className="py-2 pr-3">{t("treasury.account.details")}</th>
                  <th className="py-2 pr-3 text-right">{t("treasury.reconciliation.bookBalance")}</th>
                  <th className="py-2 pr-3 text-right">{t("treasury.reconciliation.statementBalance")}</th>
                  <th className="py-2">{t("treasury.reconciliation.title")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {accounts.map((a) => {
                  const r = byId.get(a.id);
                  return (
                    <tr key={a.id} className={a.active ? "" : "opacity-60"}>
                      <td className="py-1.5 pr-3">
                        <Link href={`/treasury/${a.id}`} className="font-medium underline-offset-2 hover:underline">
                          {a.label}
                        </Link>
                        {!a.active ? <span className="ml-1 text-xs text-slate-500">({t("treasury.account.inactive")})</span> : null}
                      </td>
                      <td className="py-1.5 pr-3"><Badge tone={kindTone(a.kind)}>{t(`treasury.kind.${a.kind}`)}</Badge></td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{a.accountNumber} · {a.currency}</td>
                      <td className="py-1.5 pr-3 text-xs text-slate-500">{a.kind === "BANK" ? [a.bankName, a.iban].filter(Boolean).join(" · ") : a.kind === "MOBILE_MONEY" ? [a.mmOperator, a.mmPhone].filter(Boolean).join(" · ") : ""}</td>
                      <td className="py-1.5 pr-3 text-right">{r?.ok ? <Money value={r.data.bookBalance} currency={a.currency} colorSign /> : "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{r?.ok ? <Money value={r.data.statementBalance} currency={a.currency} colorSign /> : "—"}</td>
                      <td className="py-1.5">
                        {r?.ok ? (
                          <Badge tone={r.data.balanced ? "success" : "warning"}>
                            {r.data.balanced ? t("treasury.reconciliation.balanced") : t("treasury.reconciliation.unbookedShort", { n: r.data.unbookedTransactions.length })}
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-500">{t("treasury.reconciliation.unavailable")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}
