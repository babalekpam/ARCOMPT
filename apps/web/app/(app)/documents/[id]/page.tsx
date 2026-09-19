import { notFound } from "next/navigation";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocumentsNav } from "@/components/documents/DocumentsNav";
import { DocumentWorkbench } from "@/components/documents/DocumentWorkbench";
import { listAllGroups } from "@/components/documents/queries";
import type { DocumentRecord } from "@/components/documents/types";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`text-sm ${mono ? "break-all font-mono text-xs" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

/** Détail d'une pièce : fiche, téléchargement, extraction / proposition, propositions connues. */
export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { t, locale } = await getT();
  const currency = config.defaultCurrency();
  const [doc, groups] = await Promise.all([apiTry<DocumentRecord>(`/documents/${id}`), listAllGroups()]);
  if (!doc.ok && "status" in doc.error && doc.error.isNotFound) notFound();
  const proposals = groups.ok ? groups.data.filter((g) => g.document?.id === id).flatMap((g) => g.proposals) : [];
  return (
    <>
      <PageHeader
        title={doc.ok ? (doc.data.filename ?? t("documents.detail.title")) : t("documents.detail.title")}
        subtitle={t("documents.subtitle")}
        actions={
          <>
            <LinkButton href="/documents" variant="secondary" size="sm">{t("documents.list.title")}</LinkButton>
            <LinkButton href={`/api/proxy/documents/${id}/download`} size="sm" external>{t("documents.download")}</LinkButton>
          </>
        }
      />
      <DocumentsNav />
      {!doc.ok ? <ApiErrorNotice error={doc.error} /> : null}
      {doc.ok ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <DocumentWorkbench document={doc.data} currency={doc.data.extracted?.currency ?? currency} proposals={proposals} />
            {groups.ok && proposals.length === 0 ? <p className="text-sm text-slate-500">{t("documents.detail.noProposals")}</p> : null}
          </div>
          <Card>
            <CardTitle>{t("documents.detail.title")}</CardTitle>
            <dl className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label={t("documents.col.file")} value={doc.data.filename} />
              <Row label={t("documents.detail.mime")} value={doc.data.mimeType} mono />
              <Row label={t("documents.detail.sha")} value={doc.data.sha256} mono />
              <Row label={t("documents.detail.uploadedBy")} value={doc.data.uploadedBy} mono />
              <Row label={t("documents.detail.createdAt")} value={formatDate(locale, doc.data.createdAt)} />
              <Row label={t("documents.detail.entry")} value={doc.data.entryId} mono />
              <Row label={t("documents.col.source")} value={t(`documents.source.${doc.data.source}`)} />
            </dl>
          </Card>
        </div>
      ) : null}
    </>
  );
}
