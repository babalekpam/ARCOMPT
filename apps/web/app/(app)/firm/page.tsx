// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import type { PackSummary } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FirmNav } from "@/components/firm/FirmNav";
import { canActAsOwner, dashboardUrgency } from "@/components/firm/helpers";
import { MfaToggle } from "@/components/firm/MfaToggle";
import { NewCompanyForm } from "@/components/firm/NewCompanyForm";
import { OpenCompanyButton } from "@/components/firm/OpenCompanyButton";
import { myRole } from "@/components/firm/queries";
import type { CompanySummary, DashboardRow, Organization } from "@/components/firm/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm">{value ?? "—"}</dd>
    </div>
  );
}

/** Portail cabinet : organisation, dossiers (+ nouveau dossier, ouvrir), tableau de bord multi-dossiers. */
export default async function FirmPage() {
  const { t, locale } = await getT();
  const auth = await requireAuthContext();
  const [org, companies, dashboard, packs, me] = await Promise.all([
    apiTry<Organization>("/portal/org"),
    apiTry<CompanySummary[]>("/portal/org/companies"),
    apiTry<DashboardRow[]>("/portal/org/dashboard"),
    apiTry<{ packs: PackSummary[] }>("/packs"),
    myRole(auth.userId, auth.tenantId),
  ]);
  const owner = canActAsOwner(me.role);
  const list = companies.ok ? companies.data : [];
  return (
    <>
      <PageHeader title={t("firm.title")} subtitle={t("firm.subtitle")} actions={me.role ? <Badge tone={me.role === "OWNER" ? "success" : "neutral"}>{t("firm.myRole", { role: t(`firm.role.${me.role}`) })}</Badge> : null} />
      <FirmNav />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>{t("firm.org.title")}</CardTitle>
          {!org.ok ? <ApiErrorNotice error={org.error} /> : null}
          {org.ok ? (
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label={t("firm.org.name")} value={org.data.name} />
              <Row label={t("firm.org.kind")} value={<Badge tone="info">{t(`firm.kind.${org.data.kind}`)}</Badge>} />
              <Row label={t("firm.org.plan")} value={org.data.plan} />
              <Row label={t("firm.org.createdAt")} value={formatDate(locale, org.data.createdAt)} />
              <Row label={t("firm.org.mfa")} value={<MfaToggle organization={org.data} canEdit={owner} />} />
              <Row label={t("settings.organizationId")} value={<span className="font-mono text-xs">{org.data.id}</span>} />
            </dl>
          ) : null}
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle hint={t("firm.companies.hint")} action={<NewCompanyForm packs={packs.ok ? packs.data.packs : []} defaultCurrency={config.defaultCurrency()} />}>
            {t("firm.companies.title")}
          </CardTitle>
          {!companies.ok ? <ApiErrorNotice error={companies.error} /> : null}
          {companies.ok && list.length === 0 ? <p className="text-sm text-slate-500">{t("firm.companies.empty")}</p> : null}
          {list.length > 0 ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="mr-auto">
                    <span className="font-medium">{c.name}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {c.countryCode.toUpperCase()} · {c.currency} · {c.accountingSystem} · {c.packVersion}
                    </span>
                    <span className="ml-2 font-mono text-[10px] text-slate-400">{c.id.slice(0, 8)}</span>
                  </span>
                  <OpenCompanyButton companyId={c.id} current={c.id === auth.tenantId} />
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
      <Card className="mt-4">
        <CardTitle hint={t("firm.dashboard.hint")}>{t("firm.dashboard.title")}</CardTitle>
        {!dashboard.ok ? <ApiErrorNotice error={dashboard.error} /> : null}
        {dashboard.ok && dashboard.data.length === 0 ? <EmptyState title={t("firm.companies.empty")} icon="◫" /> : null}
        {dashboard.ok && dashboard.data.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("firm.dashboard.company")}</th>
                  <th className="py-2 pr-3">{t("firm.dashboard.lastEntry")}</th>
                  <th className="py-2 pr-3 text-right">{t("firm.dashboard.drafts")}</th>
                  <th className="py-2 pr-3 text-right">{t("firm.dashboard.pending")}</th>
                  <th className="py-2 pr-3 text-right">{t("firm.dashboard.openPeriods")}</th>
                  <th className="py-2 pr-3">{t("firm.dashboard.workflow")}</th>
                  <th className="py-2 pr-3 text-right">{t("firm.dashboard.anomalies")}</th>
                  <th className="py-2 pr-3">{t("firm.dashboard.deadlines")}</th>
                  <th className="py-2 text-right">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {dashboard.data.map((r) => (
                  <tr key={r.companyId}>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${dashboardUrgency(r) === "danger" ? "bg-red-500" : dashboardUrgency(r) === "warning" ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden />
                        <span className="font-medium">{r.name}</span>
                      </span>
                      <span className="text-xs text-slate-500">
                        {r.countryCode.toUpperCase()} · {r.currency} · {r.fiscalYear ? `${t("common.fiscalYear")} ${r.fiscalYear.code} (${r.fiscalYear.status})` : t("firm.dashboard.noFiscalYear")}
                      </span>
                      {r.unresolvedComments > 0 || r.missingDocuments > 0 ? (
                        <span className="block text-[11px] text-slate-500">
                          {t("firm.dashboard.comments", { n: r.unresolvedComments })} · {t("firm.dashboard.missing", { n: r.missingDocuments })}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(locale, r.lastEntryDate) || "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.draftCount > 0 ? <OpenCompanyButton companyId={r.companyId} then="/entries" variant="ghost" label={String(r.draftCount)} /> : "0"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.pendingProposals === null ? "—" : r.pendingProposals > 0 ? <OpenCompanyButton companyId={r.companyId} then="/documents/review" variant="ghost" label={String(r.pendingProposals)} /> : "0"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.openPeriods}</td>
                    <td className="py-1.5 pr-3">{r.workflowState ? <Badge tone="info">{r.workflowState}</Badge> : "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.anomalies > 0 ? <OpenCompanyButton companyId={r.companyId} then="/documents/anomalies" variant="ghost" label={String(r.anomalies)} /> : "0"}</td>
                    <td className="py-1.5 pr-3">
                      {r.nextDeadlines.length === 0 ? (
                        "—"
                      ) : (
                        <ul className="space-y-0.5 text-xs">
                          {r.nextDeadlines.slice(0, 3).map((d) => (
                            <li key={d.id} className={d.daysLeft <= 7 ? "text-red-700 dark:text-red-300" : ""}>
                              {d.label} · {formatDate(locale, d.dueDate)} ({t("firm.dashboard.daysLeft", { n: d.daysLeft })})
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      <OpenCompanyButton companyId={r.companyId} current={r.companyId === auth.tenantId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-slate-500">
          <Link href="/firm/review" className="underline">{t("firm.tab.review")}</Link> · <Link href="/firm/requests" className="underline">{t("firm.tab.requests")}</Link> · <Link href="/firm/filings" className="underline">{t("firm.tab.filings")}</Link>
        </p>
      </Card>
    </>
  );
}
