// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { addAmounts, balanceSide, compareAmounts } from "@/lib/money";
import type { TrialBalance } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { BalanceFilters } from "@/components/balance/BalanceFilters";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

const isoDate = (v: unknown): string => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

export default async function BalancePage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const { fiscalYear } = resolveFiscalYear(sp);
  const cls = typeof sp.class === "string" && /^[1-9]$/.test(sp.class) ? sp.class : "";
  const from = isoDate(sp.from);
  const to = isoDate(sp.to);
  const currency = config.defaultCurrency();
  const tb = await apiTry<TrialBalance>("/entries/trial-balance", { query: { fiscalYear, from: from || undefined, to: to || undefined } });

  const rows = tb.ok ? tb.data.rows.filter((r) => (!cls || r.accountNumber.startsWith(cls)) && (r.debit !== "0.0000" || r.credit !== "0.0000")) : [];
  let totalDebit = "0";
  let totalCredit = "0";
  let totalSoldeD = "0";
  let totalSoldeC = "0";
  const computed = rows.map((r) => {
    const s = balanceSide(r.debit, r.credit);
    totalDebit = addAmounts(totalDebit, r.debit);
    totalCredit = addAmounts(totalCredit, r.credit);
    if (s.side === "D") totalSoldeD = addAmounts(totalSoldeD, s.amount);
    else totalSoldeC = addAmounts(totalSoldeC, s.amount);
    return { ...r, ...s };
  });
  const balanced = compareAmounts(totalDebit, totalCredit) === 0;
  const exportQuery = new URLSearchParams({ fiscalYear, ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();

  return (
    <>
      <PageHeader
        title={t("balance.title")}
        subtitle={t("balance.subtitle", { fy: fiscalYear })}
        actions={
          <>
            <LinkButton href={`/api/proxy/render/trial-balance.pdf?${exportQuery}`} variant="secondary" size="sm" external>
              {t("common.pdf")}
            </LinkButton>
            <LinkButton href={`/api/proxy/render/trial-balance.xlsx?${exportQuery}`} variant="secondary" size="sm" external>
              {t("common.excel")}
            </LinkButton>
          </>
        }
      />
      <Card className="mb-4">
        <BalanceFilters fiscalYear={fiscalYear} cls={cls} from={from} to={to} />
      </Card>
      {!tb.ok ? <ApiErrorNotice error={tb.error} /> : null}
      {tb.ok && computed.length === 0 ? <EmptyState title={t("balance.empty")} icon="☰" /> : null}
      {computed.length > 0 ? (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-500">
            <span>{t("balance.rows", { count: computed.length })}</span>
            {!cls ? <Badge tone={balanced ? "success" : "danger"}>{balanced ? t("balance.balanced") : t("balance.unbalanced")}</Badge> : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60">
                <tr>
                  <th className="px-4 py-2">{t("common.account")}</th>
                  <th className="px-2 py-2">{t("common.label")}</th>
                  <th className="px-2 py-2 text-right">{t("common.debit")}</th>
                  <th className="px-2 py-2 text-right">{t("common.credit")}</th>
                  <th className="px-2 py-2 text-right">{t("balance.debitBalance")}</th>
                  <th className="px-4 py-2 text-right">{t("balance.creditBalance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {computed.map((r) => (
                  <tr key={r.accountNumber} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-1.5 font-mono text-xs">{r.accountNumber}</td>
                    <td className="px-2 py-1.5">{r.label}</td>
                    <td className="px-2 py-1.5 text-right"><Money value={r.debit} currency={currency} dashForZero /></td>
                    <td className="px-2 py-1.5 text-right"><Money value={r.credit} currency={currency} dashForZero /></td>
                    <td className="px-2 py-1.5 text-right"><Money value={r.side === "D" ? r.amount : "0"} currency={currency} dashForZero /></td>
                    <td className="px-4 py-1.5 text-right"><Money value={r.side === "C" ? r.amount : "0"} currency={currency} dashForZero /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-800/60">
                  <td className="px-4 py-2" colSpan={2}>{t("balance.totals")}</td>
                  <td className="px-2 py-2 text-right"><Money value={totalDebit} currency={currency} /></td>
                  <td className="px-2 py-2 text-right"><Money value={totalCredit} currency={currency} /></td>
                  <td className="px-2 py-2 text-right"><Money value={totalSoldeD} currency={currency} /></td>
                  <td className="px-4 py-2 text-right"><Money value={totalSoldeC} currency={currency} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
