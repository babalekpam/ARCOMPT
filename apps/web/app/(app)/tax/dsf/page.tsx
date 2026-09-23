// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { apiTry } from "@/lib/api";
import { config } from "@/lib/config";
import { resolveFiscalYear, type SearchParams } from "@/lib/fiscal-year";
import { formatDate } from "@/lib/i18n";
import { getT } from "@/lib/i18n-server";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { packRefusal } from "@/lib/api";
import { PackNotice } from "@/components/packs/PackNotice";
import { SubNav } from "@/components/payroll/SubNav";
import { DsfForm } from "@/components/tax/DsfForm";
import { dsfExportHref, dsfQuery, returnTone } from "@/components/tax/helpers";
import { TAX_NAV } from "@/components/tax/nav";
import type { DsfResponse } from "@/components/tax/types";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";

const AMOUNT_RE = /^-?\d+(\.\d{1,4})?$/;

export default async function DsfPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const sp = await searchParams;
  const { fiscalYear, previousFiscalYear } = resolveFiscalYear(sp);
  const reintegrations = typeof sp.reintegrations === "string" && AMOUNT_RE.test(sp.reintegrations) ? sp.reintegrations : "0";
  const deductions = typeof sp.deductions === "string" && AMOUNT_RE.test(sp.deductions) ? sp.deductions : "0";
  const params = { reintegrations, deductions, previousFiscalYear };
  const currency = config.defaultCurrency();
  const qs = dsfQuery(params);
  const res = await apiTry<DsfResponse>(`/tax/dsf/${encodeURIComponent(fiscalYear)}${qs ? `?${qs}` : ""}`);
  const failing = res.ok ? res.data.statements.controls.filter((c) => !c.ok) : [];
  // Trois cas : liasse officielle, liasse produite sous échappement (elle part
  // marquée « NON OFFICIEL »), et refus net — l'export ne vaut alors pas d'être
  // proposé, il répondrait le même refus dans un onglet vide.
  const refused = !res.ok && packRefusal(res.error) !== null;
  const nonOfficial = res.ok && res.data.official === false;

  return (
    <>
      <PageHeader
        title={t("tax.dsf.title")}
        subtitle={t("tax.dsf.subtitle", { fy: fiscalYear })}
        actions={
          refused ? null : (
            <div className="text-right">
              <LinkButton href={dsfExportHref(fiscalYear, params)} variant="secondary" size="sm" external>
                {nonOfficial ? t("tax.dsf.exportExcelNonOfficial") : t("tax.dsf.exportExcel")}
              </LinkButton>
              {nonOfficial ? <p className="mt-1 max-w-xs text-[11px] leading-snug text-slate-500">{t("tax.dsf.exportNonOfficialHint", { fy: fiscalYear })}</p> : null}
            </div>
          )
        }
      />
      <SubNav items={TAX_NAV} />
      {res.ok && res.data.official === false ? <PackNotice surface="dsf" pack={`${res.data.packCode.toUpperCase()} ${res.data.packVersion}`} className="mt-4" /> : null}
      <Card>
        <CardTitle hint={t("tax.dsf.paramsHint")}>{t("tax.dsf.params")}</CardTitle>
        <DsfForm fiscalYear={fiscalYear} previous={previousFiscalYear ?? ""} reintegrations={reintegrations} deductions={deductions} />
      </Card>
      {!res.ok ? <div className="mt-4"><ApiErrorNotice error={res.error} /></div> : null}
      {res.ok ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone={returnTone(res.data.taxReturn.status)}>{t(`tax.returnStatus.${res.data.taxReturn.status}`)}</Badge>
            <span>{res.data.label}</span>
            <span>· {t("tax.dsf.pack", { pack: res.data.packCode.toUpperCase(), version: res.data.packVersion })}</span>
            <span>· {t("statements.system", { system: res.data.statements.system })}</span>
            <Badge tone={res.data.statements.publishable ? "success" : "danger"}>{res.data.statements.publishable ? t("statements.publishable") : t("statements.notPublishable")}</Badge>
            {failing.length > 0 ? <span>· {t("dashboard.controlsFailed", { count: failing.length })}</span> : null}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardTitle hint={t("tax.dsf.fiscalHint")}>{t("tax.dsf.fiscal")}</CardTitle>
              <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                <Row label={t("tax.dsf.accountingResult")} value={res.data.fiscal.accountingResult} currency={currency} />
                <Row label={t("tax.dsf.reintegrations")} value={res.data.fiscal.reintegrations} currency={currency} />
                <Row label={t("tax.dsf.deductions")} value={res.data.fiscal.deductions} currency={currency} />
                <Row label={t("tax.is.fiscalResult")} value={res.data.fiscal.fiscalResult} currency={currency} strong />
                <Row label={t("tax.is.turnover")} value={res.data.fiscal.turnover} currency={currency} />
                <Row label={t("tax.is.isAmount")} value={res.data.fiscal.isAmount} currency={currency} />
                <Row label={t("tax.is.imfAmount")} value={res.data.fiscal.imfAmount} currency={currency} />
                <Row label={t("tax.is.due")} value={res.data.fiscal.isDue} currency={currency} strong />
              </dl>
              {res.data.fiscal.rules.length > 0 ? (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("tax.dsf.rules")}</p>
                  <ul className="space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                    {res.data.fiscal.rules.map((r) => (
                      <li key={r.id}>
                        <span className="font-mono">{r.id}</span> · {formatDate(locale, r.validFrom)}
                        {r.source ? <span className="text-slate-400"> · {r.source}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
            <Card>
              <CardTitle hint={t("tax.dsf.jsonHint")}>{t("tax.dsf.json")}</CardTitle>
              <pre className="max-h-[32rem] overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-snug text-slate-100">{JSON.stringify({ taxReturn: res.data.taxReturn, fiscalYearCode: res.data.fiscalYearCode, packCode: res.data.packCode, packVersion: res.data.packVersion, label: res.data.label, fiscal: res.data.fiscal, controls: res.data.statements.controls, notes: res.data.statements.notes.map((n) => ({ number: n.number, title: n.title, total: n.total, status: n.status })) }, null, 2)}</pre>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}

function Row({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-2 ${strong ? "font-semibold" : ""}`}>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd>
        <Money value={value} currency={currency} colorSign showCurrency />
      </dd>
    </div>
  );
}
