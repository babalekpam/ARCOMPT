// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { confidenceTone, formatConfidence } from "@/components/documents/helpers";
import { FirmNav } from "@/components/firm/FirmNav";
import { summarizeProposal } from "@/components/firm/helpers";
import { OpenCompanyButton } from "@/components/firm/OpenCompanyButton";
import type { OrgReviewQueue } from "@/components/firm/types";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

/** File de revue de tous les dossiers du cabinet : nombre en attente par dossier, aperçu des propositions, ouverture du dossier. */
export default async function FirmReviewPage() {
  const { t, locale } = await getT();
  const auth = await requireAuthContext();
  const queue = await apiTry<OrgReviewQueue>("/portal/org/review-queue");
  return (
    <>
      <PageHeader title={t("firm.review.title")} subtitle={t("firm.review.subtitle")} actions={queue.ok ? <Badge tone={queue.data.totalPending > 0 ? "warning" : "success"}>{t("firm.review.total", { n: queue.data.totalPending })}</Badge> : null} />
      <FirmNav />
      {!queue.ok ? <ApiErrorNotice error={queue.error} /> : null}
      {queue.ok && !queue.data.available ? <Alert tone="info">{t("firm.review.unavailable")}</Alert> : null}
      {queue.ok && queue.data.companies.length === 0 ? <EmptyState title={t("firm.review.empty")} icon="✔" /> : null}
      {queue.ok ? (
        <div className="space-y-4">
          {queue.data.companies.map((c) => (
            <Card key={c.companyId}>
              <CardTitle hint={t("firm.review.pendingCount", { n: c.pending })} action={<OpenCompanyButton companyId={c.companyId} current={false} then="/documents/review" label={t("firm.review.open")} />}>
                {c.name}
                {c.companyId === auth.tenantId ? <span className="ml-2 text-xs font-normal normal-case text-slate-500">({t("firm.companies.current")})</span> : null}
              </CardTitle>
              {c.proposals.length === 0 ? (
                <p className="text-sm text-slate-500">{t("firm.review.empty")}</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {c.proposals.map((raw, i) => {
                    const p = summarizeProposal(raw);
                    return (
                      <li key={`${p.id}-${i}`} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                        <span className="mr-auto truncate">{p.label}</span>
                        {p.route ? <Badge tone={p.route === "ONE_TAP_VALIDATION" ? "success" : p.route === "REJECTED" ? "danger" : "warning"}>{t(`documents.route.${p.route}`)}</Badge> : null}
                        {p.confidence !== null ? <Badge tone={confidenceTone(p.confidence)}>{formatConfidence(p.confidence)}</Badge> : null}
                        {p.createdAt ? <span className="text-xs text-slate-500">{formatDate(locale, p.createdAt)}</span> : null}
                        <span className="font-mono text-[10px] text-slate-400">{p.id.slice(0, 8)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ))}
        </div>
      ) : null}
    </>
  );
}
