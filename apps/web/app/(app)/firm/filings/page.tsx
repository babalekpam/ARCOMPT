import Link from "next/link";
import { apiTry } from "@/lib/api";
import { requireAuthContext } from "@/lib/auth";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FilingActions, PrepareFilingForm } from "@/components/firm/FilingForms";
import { FirmNav } from "@/components/firm/FirmNav";
import { filingTone } from "@/components/firm/helpers";
import type { DashboardRow, Filing } from "@/components/firm/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

/** Dépôts (DSF, TVA, social) du dossier courant : préparer, marquer déposé, joindre l'accusé. */
export default async function FirmFilingsPage() {
  const { t, locale } = await getT();
  const auth = await requireAuthContext();
  const [filings, dashboard] = await Promise.all([apiTry<Filing[]>("/portal/filings"), apiTry<DashboardRow[]>("/portal/org/dashboard")]);
  const fy = dashboard.ok ? dashboard.data.find((r) => r.companyId === auth.tenantId)?.fiscalYear : null;
  const fiscalYears = fy ? [{ id: fy.id, code: fy.code }] : [];
  return (
    <>
      <PageHeader title={t("firm.filings.title")} subtitle={t("firm.filings.subtitle")} actions={<PrepareFilingForm fiscalYears={fiscalYears} />} />
      <FirmNav />
      <Card>
        <CardTitle hint={t("firm.filings.hint")}>{t("firm.filings.list")}</CardTitle>
        {!filings.ok ? <ApiErrorNotice error={filings.error} /> : null}
        {filings.ok && filings.data.length === 0 ? <EmptyState title={t("firm.filings.empty")} icon="▤" /> : null}
        {filings.ok && filings.data.length > 0 ? (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">{t("firm.filings.kind")}</th>
                  <th className="py-2 pr-3">{t("firm.filings.period")}</th>
                  <th className="py-2 pr-3">{t("firm.filings.portal")}</th>
                  <th className="py-2 pr-3">{t("common.status")}</th>
                  <th className="py-2 pr-3">{t("firm.filings.documents")}</th>
                  <th className="py-2">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filings.data.map((f) => (
                  <tr key={f.id}>
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">{t(`firm.filings.kind.${f.kind}`)}</span>
                      <span className="ml-1 text-xs text-slate-500">{f.format}</span>
                      <p className="font-mono text-[10px] text-slate-400">{f.id}</p>
                    </td>
                    <td className="py-1.5 pr-3">{f.periodLabel ?? "—"}</td>
                    <td className="py-1.5 pr-3">{f.portalName}</td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={filingTone(f.status)}>{t(`firm.filings.status.${f.status}`)}</Badge>
                      {f.filedAt ? <p className="text-xs text-slate-500">{formatDate(locale, f.filedAt)}</p> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-xs">
                      {f.fileDocumentId ? <Link href={`/documents/${f.fileDocumentId}`} className="block font-mono underline">{t("firm.filings.file")} {f.fileDocumentId.slice(0, 8)}</Link> : null}
                      {f.receiptDocumentId ? <Link href={`/documents/${f.receiptDocumentId}`} className="block font-mono underline">{t("firm.filings.receipt")} {f.receiptDocumentId.slice(0, 8)}</Link> : null}
                      {!f.fileDocumentId && !f.receiptDocumentId ? "—" : null}
                    </td>
                    <td className="py-1.5"><FilingActions filing={f} /></td>
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
