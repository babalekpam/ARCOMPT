import Link from "next/link";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { DocumentsNav } from "@/components/documents/DocumentsNav";
import { ReviewQueue } from "@/components/documents/ReviewQueue";
import type { DocumentSource, ReviewQueueGroup } from "@/components/documents/types";
import { PageHeader } from "@/components/ui/PageHeader";

const ROUTES = ["REVIEW_QUEUE", "ONE_TAP_VALIDATION", "ALL"] as const;
const SOURCES = ["UPLOAD", "WHATSAPP", "EMAIL", "BANK"] as const;

/** File de revue du comptable : propositions en attente, groupées par pièce. */
export default async function ReviewPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const route = typeof sp.route === "string" && (ROUTES as readonly string[]).includes(sp.route) ? (sp.route as (typeof ROUTES)[number]) : "REVIEW_QUEUE";
  const source = typeof sp.source === "string" && (SOURCES as readonly string[]).includes(sp.source) ? (sp.source as DocumentSource) : undefined;
  const groups = await apiTry<ReviewQueueGroup[]>("/proposals", { query: { status: "PENDING", route, source, limit: 200 } });
  const href = (r: string, s?: string) => `/documents/review?route=${r}${s ? `&source=${s}` : ""}`;
  const pill = (active: boolean) => `whitespace-nowrap rounded-full border px-3 py-1 text-xs ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`;
  const count = groups.ok ? groups.data.reduce((n, g) => n + g.proposals.length, 0) : 0;
  return (
    <>
      <PageHeader title={t("documents.review.title")} subtitle={t("documents.review.subtitle")} actions={groups.ok ? <span className="text-sm text-slate-500">{t("documents.review.count", { n: count })}</span> : null} />
      <DocumentsNav />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{t("documents.review.filterRoute")}</span>
        {ROUTES.map((r) => (
          <Link key={r} href={href(r, source)} className={pill(r === route)}>
            {r === "ALL" ? t("common.all") : t(`documents.route.${r}`)}
          </Link>
        ))}
        <span className="ml-3 text-slate-500">{t("documents.review.filterSource")}</span>
        <Link href={href(route)} className={pill(!source)}>{t("common.all")}</Link>
        {SOURCES.map((s) => (
          <Link key={s} href={href(route, s)} className={pill(s === source)}>
            {t(`documents.source.${s}`)}
          </Link>
        ))}
      </div>
      {!groups.ok ? <ApiErrorNotice error={groups.error} /> : <ReviewQueue key={`${route}-${source ?? ""}-${count}`} groups={groups.data} currency={config.defaultCurrency()} />}
    </>
  );
}
