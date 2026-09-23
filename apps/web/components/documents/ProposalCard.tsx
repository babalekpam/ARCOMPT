// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-client";
import { formatDate } from "@/lib/i18n";
import { Badge } from "@/components/ui/Badge";
import { Money } from "@/components/ui/Money";
import { confidenceTone, formatConfidence, proposalStatusTone, proposalTotals, routeTone } from "./helpers";
import type { ProposalLine, ProposalRecord } from "./types";

/** Tableau des lignes d'une proposition (comptes, libellés, débit / crédit) avec totaux. */
export function ProposalLinesTable({ lines, currency }: { lines: ProposalLine[]; currency: string }) {
  const { t } = useI18n();
  const totals = proposalTotals(lines);
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[28rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="py-1.5 pr-3">{t("documents.proposal.account")}</th>
            <th className="py-1.5 pr-3">{t("common.label")}</th>
            <th className="py-1.5 pr-3 text-right">{t("common.debit")}</th>
            <th className="py-1.5 text-right">{t("common.credit")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.map((l, i) => (
            <tr key={`${l.account_number}-${i}`}>
              <td className="py-1.5 pr-3">
                <span className="font-mono text-xs">{l.account_number}</span>
                {l.account_label ? <span className="ml-2 text-xs text-slate-500">{l.account_label}</span> : null}
              </td>
              <td className="py-1.5 pr-3">
                {l.label ?? "—"}
                {l.partner_name ? <span className="ml-1 text-xs text-slate-500">· {l.partner_name}</span> : null}
                {l.vat_code ? <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] dark:bg-slate-800">{l.vat_code}</span> : null}
              </td>
              <td className="py-1.5 pr-3 text-right"><Money value={l.debit ?? null} currency={currency} /></td>
              <td className="py-1.5 text-right"><Money value={l.credit ?? null} currency={currency} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={`border-t-2 font-semibold ${totals.balanced ? "border-slate-300 dark:border-slate-700" : "border-red-400 text-red-700 dark:text-red-300"}`}>
            <td className="py-1.5 pr-3" colSpan={2}>{t("common.total")}{totals.balanced ? "" : ` · ${t("documents.review.unbalanced")}`}</td>
            <td className="py-1.5 pr-3 text-right"><Money value={totals.debit} currency={currency} /></td>
            <td className="py-1.5 text-right"><Money value={totals.credit} currency={currency} /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Proposition d'écriture IA : en-tête, lignes, confiance, contrôles et route. Rien n'est comptabilisé sans validation humaine. */
export function ProposalCard({ proposal, currency, actions, compact = false }: { proposal: ProposalRecord; currency: string; actions?: ReactNode; compact?: boolean }) {
  const { t, locale } = useI18n();
  const p = proposal.proposal;
  const lines = proposal.correction ?? p.lines;
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">{p.label}</h3>
        <Badge tone={routeTone(proposal.route)}>{t(`documents.route.${proposal.route}`)}</Badge>
        <Badge tone={proposalStatusTone(proposal.status)}>{t(`documents.pstatus.${proposal.status}`)}</Badge>
        <Badge tone={confidenceTone(proposal.confidence)}>{t("documents.proposal.confidence")} {formatConfidence(proposal.confidence)}</Badge>
      </div>
      <p className="mb-2 text-xs text-slate-500">
        {t("common.journal")} <span className="font-mono">{p.journal_code}</span> · {t("common.date")} {formatDate(locale, p.date)}
        {p.reference ? <> · {t("common.reference")} {p.reference}</> : null}
        {p.categorized_by ? <> · {t("documents.proposal.categorizedBy")} {p.categorized_by}</> : null}
        {" · "}
        <span className="font-mono text-[10px]">{proposal.id}</span>
      </p>
      <ProposalLinesTable lines={lines} currency={currency} />
      {!compact && p.rationale ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300"><span className="font-medium">{t("documents.proposal.rationale")} :</span> {p.rationale}</p> : null}
      {proposal.guardIssues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {proposal.guardIssues.map((i, k) => (
            <li key={`${i.code}-${k}`} className="flex items-start gap-2 text-xs">
              <Badge tone={proposal.route === "REJECTED" ? "danger" : "warning"}>{i.code}</Badge>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      ) : !compact ? (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{t("documents.proposal.noIssues")}</p>
      ) : null}
      {!compact && p.alternatives.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">{t("documents.proposal.alternatives")}</summary>
          <ul className="mt-1 list-disc pl-5">
            {p.alternatives.map((a, i) => (
              <li key={i}><span className="font-mono">{a.account_number}</span> — {a.rationale}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {proposal.entryId ? (
        <p className="mt-2 text-xs">
          {t("documents.proposal.entry")} <Link href="/entries" className="font-mono underline">{proposal.entryId}</Link>
        </p>
      ) : null}
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      {!actions && proposal.status === "PENDING" && proposal.route !== "REJECTED" ? (
        <p className="mt-3 text-xs">
          <Link href="/documents/review" className="underline">{t("documents.proposal.goReview")}</Link>
        </p>
      ) : null}
    </article>
  );
}
