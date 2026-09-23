// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocumentsNav } from "@/components/documents/DocumentsNav";
import { confidenceTone, documentStatusTone, formatBytes, formatConfidence, groupsToDocuments, routeTone } from "@/components/documents/helpers";
import { OpenDocumentForm } from "@/components/documents/OpenDocumentForm";
import { listAllGroups } from "@/components/documents/queries";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

/** Liste des pièces (dérivée des propositions) avec statuts, dernière route et confiance. */
export default async function DocumentsPage() {
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const groups = await listAllGroups();
  const items = groups.ok ? groupsToDocuments(groups.data) : [];
  const pending = items.reduce((n, i) => n + i.pendingCount, 0);
  return (
    <>
      <PageHeader
        title={t("documents.title")}
        subtitle={t("documents.subtitle")}
        actions={
          <>
            <LinkButton href="/documents/review" variant="secondary">
              {t("documents.review.title")}
              {pending > 0 ? <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{pending}</span> : null}
            </LinkButton>
            <LinkButton href="/documents/upload">{t("documents.upload.title")}</LinkButton>
          </>
        }
      />
      <DocumentsNav />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint={t("documents.list.hint")}>{t("documents.list.title")}</CardTitle>
          {!groups.ok ? <ApiErrorNotice error={groups.error} /> : null}
          {groups.ok && items.length === 0 ? <EmptyState title={t("documents.list.empty")} body={t("documents.list.emptyHint")} action={<LinkButton href="/documents/upload">{t("documents.upload.title")}</LinkButton>} icon="✦" /> : null}
          {items.length > 0 ? (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">{t("documents.col.file")}</th>
                    <th className="py-2 pr-3">{t("common.date")}</th>
                    <th className="py-2 pr-3">{t("documents.col.source")}</th>
                    <th className="py-2 pr-3">{t("common.status")}</th>
                    <th className="py-2 pr-3">{t("documents.col.proposal")}</th>
                    <th className="py-2 text-right">{t("common.amount")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map(({ document: d, latest, pendingCount }) => {
                    const ttc = d.extracted?.amount_incl_tax ?? latest?.extraction?.amount_incl_tax ?? null;
                    const cur = d.extracted?.currency ?? latest?.extraction?.currency ?? currency;
                    return (
                      <tr key={d.id}>
                        <td className="py-1.5 pr-3">
                          <Link href={`/documents/${d.id}`} className="font-medium underline">{d.filename ?? d.id.slice(0, 8)}</Link>
                          <p className="text-[11px] text-slate-500">{formatBytes(d.sizeBytes)} · {d.extracted?.supplier_name ?? d.mimeType}</p>
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(locale, d.createdAt)}</td>
                        <td className="py-1.5 pr-3"><Badge tone="neutral">{t(`documents.source.${d.source}`)}</Badge></td>
                        <td className="py-1.5 pr-3"><Badge tone={documentStatusTone(d.status)}>{t(`documents.status.${d.status}`)}</Badge></td>
                        <td className="py-1.5 pr-3">
                          {latest ? (
                            <span className="flex flex-wrap items-center gap-1">
                              <Badge tone={routeTone(latest.route)}>{t(`documents.route.${latest.route}`)}</Badge>
                              <Badge tone={confidenceTone(latest.confidence)}>{formatConfidence(latest.confidence)}</Badge>
                              {pendingCount > 0 ? <Link href="/documents/review" className="text-xs underline">{t("documents.pstatus.PENDING")} ({pendingCount})</Link> : null}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-1.5 text-right"><Money value={ttc} currency={cur} showCurrency /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
        <div className="space-y-4">
          <Card>
            <CardTitle hint={t("documents.openByIdHint")}>{t("documents.openById")}</CardTitle>
            <OpenDocumentForm />
          </Card>
          <Card>
            <CardTitle>{t("documents.anomalies.title")}</CardTitle>
            <p className="text-sm text-slate-500">{t("documents.anomalies.subtitle")}</p>
            <LinkButton href="/documents/anomalies" variant="secondary" size="sm" className="mt-3">{t("documents.anomalies.title")}</LinkButton>
          </Card>
        </div>
      </div>
    </>
  );
}
