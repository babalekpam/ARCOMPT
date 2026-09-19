import Link from "next/link";
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { getT } from "@/lib/i18n-server";
import type { StatementCode, StatementsOutput } from "@/lib/types";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { FiscalYearPicker } from "@/components/FiscalYearPicker";
import { ControlsList } from "@/components/statements/ControlsList";
import { NotesList } from "@/components/statements/NotesList";
import { StatementTable } from "@/components/statements/StatementTable";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

const TABS = ["BILAN_ACTIF", "BILAN_PASSIF", "COMPTE_RESULTAT", "TFT", "notes", "controls"] as const;
type Tab = (typeof TABS)[number];

export default async function StatementsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t } = await getT();
  const sp = await searchParams;
  const { fiscalYear, previousFiscalYear } = resolveFiscalYear(sp);
  const tab: Tab = typeof sp.tab === "string" && (TABS as readonly string[]).includes(sp.tab) ? (sp.tab as Tab) : "BILAN_ACTIF";
  const currency = config.defaultCurrency();
  const st = await apiTry<StatementsOutput>("/statements", { query: { fiscalYear, previousFiscalYear, currency } });
  const exportQuery = new URLSearchParams({ fiscalYear, ...(previousFiscalYear ? { previousFiscalYear } : {}), currency }).toString();
  const tabHref = (x: Tab) => `/statements?fy=${fiscalYear}${previousFiscalYear ? `&prev=${previousFiscalYear}` : ""}&tab=${x}`;
  const failing = st.ok ? st.data.controls.filter((c) => !c.ok).length : 0;

  return (
    <>
      <PageHeader
        title={t("statements.title")}
        subtitle={t("statements.subtitle")}
        actions={
          <>
            <FiscalYearPicker value={fiscalYear} previous={previousFiscalYear ?? ""} />
            <LinkButton href={`/api/proxy/render/statements.pdf?${exportQuery}`} variant="secondary" size="sm" external>
              {t("common.pdf")}
            </LinkButton>
            <LinkButton href={`/api/proxy/render/statements.xlsx?${exportQuery}`} variant="secondary" size="sm" external>
              {t("common.excel")}
            </LinkButton>
          </>
        }
      />
      {!st.ok ? <ApiErrorNotice error={st.error} /> : null}
      {st.ok ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone={st.data.publishable ? "success" : "danger"}>{st.data.publishable ? t("statements.publishable") : t("statements.notPublishable")}</Badge>
            <span>{st.data.publishable ? t("statements.publishableHint") : t("statements.notPublishableHint")}</span>
            <span>· {t("statements.template", { id: st.data.templateId, version: st.data.templateVersion })}</span>
            <span>· {t("statements.system", { system: st.data.system })}</span>
            <span>· {st.data.currency}</span>
          </div>
          {!previousFiscalYear ? <Alert tone="info" className="mb-4">{t("statements.noPrevious")}</Alert> : null}
          <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Onglets">
            {TABS.map((x) => (
              <Link key={x} href={tabHref(x)} aria-current={x === tab ? "page" : undefined} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${x === tab ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
                {t(`statements.tab.${x}`)}
                {x === "controls" && failing > 0 ? <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[10px] text-white">{failing}</span> : null}
              </Link>
            ))}
          </nav>
          {tab === "notes" ? (
            <NotesList notes={st.data.notes} currency={currency} />
          ) : tab === "controls" ? (
            <ControlsList controls={st.data.controls} orphanAccounts={st.data.orphanAccounts} />
          ) : st.data.statements[tab as StatementCode] ? (
            <StatementTable statement={st.data.statements[tab as StatementCode]} currency={currency} />
          ) : (
            <EmptyState title={t("statements.empty", { fy: fiscalYear })} />
          )}
        </>
      ) : null}
    </>
  );
}
