// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { formatDate, type Locale, type Translator } from "@/lib/i18n";
import { Badge } from "@/components/ui/Badge";
import { Money } from "@/components/ui/Money";
import type { ReconciliationReport } from "./types";

/** Rapport de rapprochement (composant serveur) : soldes, écarts, éléments en suspens de part et d'autre. */
export function ReconciliationCard({ report, t, locale, compact = false }: { report: ReconciliationReport; t: Translator; locale: Locale; compact?: boolean }) {
  const cur = report.account.currency;
  const Row = ({ label, value, strong = false }: { label: string; value: string | null; strong?: boolean }) => (
    <div className={`flex items-center justify-between gap-3 py-1 ${strong ? "font-semibold" : ""}`}>
      <dt className="text-slate-500">{label}</dt>
      <dd>{value === null ? "—" : <Money value={value} currency={cur} colorSign />}</dd>
    </div>
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={report.balanced ? "success" : "warning"}>{report.balanced ? t("treasury.reconciliation.balanced") : t("treasury.reconciliation.unbalanced")}</Badge>
        <span className="text-xs text-slate-500">{t("treasury.reconciliation.asOf", { date: formatDate(locale, report.asOf) })}</span>
        {report.reconciledFrom ? <span className="text-xs text-slate-500">· {t("treasury.reconciliation.from", { date: formatDate(locale, report.reconciledFrom) })}</span> : null}
      </div>
      <dl className="divide-y divide-slate-100 dark:divide-slate-800">
        <Row label={t("treasury.reconciliation.bookBalance")} value={report.bookBalance} />
        <Row label={t("treasury.reconciliation.statementBalance")} value={report.statementBalance} />
        <Row label={t("treasury.reconciliation.unbooked", { n: report.unbookedTransactions.length })} value={report.unbookedTransactions.length > 0 ? null : "0"} />
        <Row label={t("treasury.reconciliation.uncleared", { n: report.unclearedLines.length })} value={report.unclearedLines.length > 0 ? null : "0"} />
        <Row label={t("treasury.reconciliation.adjustedBook")} value={report.adjustedBookBalance} strong />
        <Row label={t("treasury.reconciliation.adjustedStatement")} value={report.adjustedStatementBalance} strong />
        <Row label={t("treasury.reconciliation.difference")} value={report.difference} strong />
      </dl>
      {report.ignoredTransactions > 0 ? <p className="text-xs text-slate-500">{t("treasury.reconciliation.ignored", { n: report.ignoredTransactions })}</p> : null}
      {!compact && report.unbookedTransactions.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("treasury.reconciliation.unbookedTitle")}</p>
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {report.unbookedTransactions.slice(0, 20).map((i) => (
              <li key={i.id} className="flex justify-between gap-2 py-1">
                <span className="truncate">{formatDate(locale, i.date)} · {i.label}</span>
                <Money value={i.amount} currency={cur} colorSign />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!compact && report.unclearedLines.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("treasury.reconciliation.unclearedTitle")}</p>
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {report.unclearedLines.slice(0, 20).map((i) => (
              <li key={i.id} className="flex justify-between gap-2 py-1">
                <span className="truncate">{formatDate(locale, i.date)} · {i.label}</span>
                <Money value={i.amount} currency={cur} colorSign />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.cashCountAnomalies.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">{t("treasury.cash.anomalies", { n: report.cashCountAnomalies.length })}</p>
          <ul>
            {report.cashCountAnomalies.slice(0, 5).map((a) => (
              <li key={a.cashCountId}>
                {formatDate(locale, a.countedOn)} : <Money value={a.difference} currency={cur} colorSign />
                {a.note ? ` — ${a.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
