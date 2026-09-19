import Link from "next/link";
import { apiTry } from "@/lib/api";
import type { SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FirmNav } from "@/components/firm/FirmNav";
import { MarkReceivedForm, MissingDocForm } from "@/components/firm/MissingDocuments";
import type { MissingDocumentRequest } from "@/components/firm/types";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

/** Pièces manquantes du dossier courant : demandes (WhatsApp / e-mail) et réception. */
export default async function FirmRequestsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const openOnly = sp.all !== "1";
  const requests = await apiTry<MissingDocumentRequest[]>("/portal/missing-documents", { query: { open: openOnly ? "true" : undefined } });
  const pill = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`;
  return (
    <>
      <PageHeader title={t("firm.requests.title")} subtitle={t("firm.requests.subtitle")} />
      <FirmNav />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle hint={t("firm.requests.hint")}>{t("firm.requests.new")}</CardTitle>
          <MissingDocForm />
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle
            action={
              <span className="flex gap-1">
                <Link href="/firm/requests" className={pill(openOnly)}>{t("firm.requests.open")}</Link>
                <Link href="/firm/requests?all=1" className={pill(!openOnly)}>{t("common.all")}</Link>
              </span>
            }
          >
            {t("firm.requests.list")}
          </CardTitle>
          {!requests.ok ? <ApiErrorNotice error={requests.error} /> : null}
          {requests.ok && requests.data.length === 0 ? <EmptyState title={t("firm.requests.empty")} icon="✔" /> : null}
          {requests.ok && requests.data.length > 0 ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {requests.data.map((r) => (
                <li key={r.id} className="space-y-2 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-auto font-medium">{r.description}</span>
                    <Badge tone="neutral">{r.channel === "WHATSAPP" ? "WhatsApp" : t("firm.requests.email")}</Badge>
                    <Badge tone={r.receivedAt ? "success" : r.sentAt ? "info" : "warning"}>{r.receivedAt ? t("firm.requests.received") : r.sentAt ? t("firm.requests.sentBadge") : t("firm.requests.notSent")}</Badge>
                  </div>
                  <p className="text-xs text-slate-500">
                    {t("firm.requests.recipient")} {r.recipient} · {formatDate(locale, r.createdAt)}
                    {r.sentAt ? <> · {t("firm.requests.sentAt")} {formatDate(locale, r.sentAt)}</> : null}
                    {r.receivedDocumentId ? (
                      <>
                        {" · "}
                        <Link href={`/documents/${r.receivedDocumentId}`} className="font-mono underline">{r.receivedDocumentId.slice(0, 8)}</Link>
                      </>
                    ) : null}
                    {r.entryId ? <> · {t("firm.requests.entry")} <span className="font-mono">{r.entryId.slice(0, 8)}</span></> : null}
                  </p>
                  {!r.receivedAt ? <MarkReceivedForm requestId={r.id} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
    </>
  );
}
