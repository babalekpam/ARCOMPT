// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { computeDashboard } from "@/lib/dashboard";
import { isNegative } from "@/lib/money";
import type { StatementsOutput, TrialBalance } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FiscalYearPicker } from "@/components/FiscalYearPicker";
import { RecentEntries } from "@/components/dashboard/RecentEntries";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { getPlatformAdmin, shouldShowPlatformPicker } from "@/lib/platform";
import { redirect } from "next/navigation";

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const auth = await requireAuthContext();
  if (shouldShowPlatformPicker(await getPlatformAdmin(), auth.tenantId)) redirect("/platform");
  if (auth.mode === "clerk" && !auth.tenantId) redirect("/api/session/landing");
  const { fiscalYear, previousFiscalYear } = resolveFiscalYear(await searchParams);
  const currency = config.defaultCurrency();
  const [tb, st] = await Promise.all([
    apiTry<TrialBalance>("/entries/trial-balance", { query: { fiscalYear } }),
    apiTry<StatementsOutput>("/statements", { query: { fiscalYear, previousFiscalYear, currency } }),
  ]);
  const kpis = tb.ok ? computeDashboard(tb.data) : null;
  const failing = st.ok ? st.data.controls.filter((c) => !c.ok) : [];

  return (
    <>
      <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.subtitle", { fy: fiscalYear })} actions={<FiscalYearPicker value={fiscalYear} />} />
      {!auth.tenantId ? <EmptyState title={t("company.none")} body={t("company.manualHint")} /> : null}
      {!tb.ok ? <ApiErrorNotice error={tb.error} /> : null}
      {tb.ok && tb.data.rows.length === 0 ? (
        <EmptyState title={t("dashboard.emptyTitle")} body={t("dashboard.emptyBody")} action={<LinkButton href="/entries/new">{t("dashboard.newEntry")}</LinkButton>} icon="▦" />
      ) : null}
      {kpis && tb.ok && tb.data.rows.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label={t("dashboard.cash")} hint={t("dashboard.cashHint")} value={kpis.cash} currency={currency} />
          <Kpi label={t("dashboard.receivables")} hint={t("dashboard.receivablesHint")} value={kpis.receivables} currency={currency} />
          <Kpi label={t("dashboard.payables")} hint={t("dashboard.payablesHint")} value={kpis.payables} currency={currency} />
          <Kpi label={t("dashboard.result")} hint={t("dashboard.resultHint")} value={kpis.result} currency={currency} badge={<Badge tone={isNegative(kpis.result) ? "danger" : "success"}>{isNegative(kpis.result) ? t("dashboard.loss") : t("dashboard.profit")}</Badge>} />
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint={t("dashboard.lastEntriesHint")} action={<LinkButton href="/entries/new" size="sm">{t("dashboard.newEntry")}</LinkButton>}>
            {t("dashboard.lastEntries")}
          </CardTitle>
          <RecentEntries currency={currency} limit={8} />
        </Card>
        <Card>
          <CardTitle action={<Link href={`/statements?fy=${fiscalYear}&tab=controls`} className="text-xs underline">{t("dashboard.seeStatements")}</Link>}>{t("dashboard.alerts")}</CardTitle>
          {!st.ok ? (
            <p className="text-xs text-slate-500">{t("common.empty")}</p>
          ) : failing.length === 0 ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-300">{t("dashboard.noAlerts")}</p>
          ) : (
            <>
              <p className="mb-2 text-xs text-slate-500">{t("dashboard.controlsFailed", { count: failing.length })}</p>
              <ul className="space-y-2">
                {failing.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Badge tone={c.severity === "BLOCKING" ? "danger" : "warning"}>{t(`statements.severity.${c.severity}`)}</Badge>
                    <div>
                      <div className="font-medium">{c.label}</div>
                      <div className="text-xs text-slate-500">{c.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function Kpi({ label, hint, value, currency, badge }: { label: string; hint: string; value: string; currency: string; badge?: React.ReactNode }) {
  return (
    <Card as="div">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        {badge}
      </div>
      <p className="mt-2 text-2xl font-semibold">
        <Money value={value} currency={currency} showCurrency colorSign />
      </p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </Card>
  );
}