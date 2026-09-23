// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import type { Control } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FiscalYearPicker } from "@/components/FiscalYearPicker";
import { Checklist } from "@/components/closing/Checklist";
import { LockFiscalYear } from "@/components/closing/LockFiscalYear";
import { MonthlyChecklist } from "@/components/closing/MonthlyChecklist";
import { PeriodsTable } from "@/components/closing/PeriodsTable";
import type { ChecklistItem, FiscalYearWorkflow, PeriodInfo } from "@/components/closing/types";
import { WorkflowCard } from "@/components/closing/WorkflowCard";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function ClosingPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const auth = await requireAuthContext();
  const { fiscalYear } = resolveFiscalYear(await searchParams);
  const fy = encodeURIComponent(fiscalYear);
  const [workflow, controls, periods, annual] = await Promise.all([
    apiTry<FiscalYearWorkflow>(`/closing/fiscal-years/${fy}/workflow`),
    apiTry<Control[]>(`/closing/fiscal-years/${fy}/controls`),
    apiTry<PeriodInfo[]>("/closing/periods", { query: { fiscalYear } }),
    apiTry<ChecklistItem[]>("/closing/checklist", { query: { fiscalYear } }),
  ]);
  const periodList = periods.ok ? periods.data : [];
  const allLocked = periodList.length > 0 && periodList.every((p) => p.status === "LOCKED");
  const openCount = periodList.filter((p) => p.status === "OPEN").length;

  return (
    <>
      <PageHeader title={t("closing.title")} subtitle={t("closing.subtitle", { fy: fiscalYear })} actions={<FiscalYearPicker value={fiscalYear} />} />
      {!workflow.ok ? <ApiErrorNotice error={workflow.error} /> : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint={t("closing.workflow.hint")}>{t("closing.workflow.title")}</CardTitle>
          {workflow.ok ? <WorkflowCard workflow={workflow.data} /> : <p className="text-sm text-slate-500">{t("common.empty")}</p>}
        </Card>
        <Card>
          <CardTitle hint={t("closing.controls.hint")}>{t("closing.controls.title")}</CardTitle>
          {!controls.ok ? <ApiErrorNotice error={controls.error} /> : null}
          {controls.ok && controls.data.length === 0 ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{t("closing.controls.none")}</p> : null}
          {controls.ok && controls.data.length > 0 ? (
            <ul className="space-y-2">
              {controls.data.map((c) => (
                <li key={c.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone="danger">{t(`statements.severity.${c.severity}`)}</Badge>
                    <span className="font-medium">{c.label}</span>
                  </div>
                  <p className="text-xs text-slate-500">{c.detail}</p>
                  {c.expected !== undefined || c.actual !== undefined ? (
                    <p className="font-mono text-[11px] text-slate-500">
                      {t("statements.expected")} {c.expected ?? "—"} · {t("statements.actual")} {c.actual ?? "—"}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
            <p className="mb-2 text-xs text-slate-500">{allLocked ? t("closing.lock.already") : t("closing.lock.hintShort", { open: openCount })}</p>
            <LockFiscalYear fiscalYear={fiscalYear} disabled={allLocked} />
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle hint={t("closing.periods.hint")}>{t("closing.periods.title")}</CardTitle>
        {!periods.ok ? <ApiErrorNotice error={periods.error} /> : <PeriodsTable periods={periodList} currentUserId={auth.userId} />}
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={t("closing.checklist.monthlyHint")}>{t("closing.checklist.monthly")}</CardTitle>
          <MonthlyChecklist fiscalYear={fiscalYear} periods={periodList} />
        </Card>
        <Card>
          <CardTitle hint={t("closing.checklist.annualHint")}>{t("closing.checklist.annual")}</CardTitle>
          {!annual.ok ? <ApiErrorNotice error={annual.error} /> : <Checklist fiscalYear={fiscalYear} initialItems={annual.data} />}
        </Card>
      </div>
    </>
  );
}
