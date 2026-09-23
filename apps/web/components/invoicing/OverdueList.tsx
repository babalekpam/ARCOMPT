// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import Link from "next/link";
import { formatDate, type Locale, type Translator } from "@/lib/i18n";
import { Money } from "@/components/ui/Money";
import { DunningButtons } from "./DunningButtons";
import type { OverdueInvoice } from "./types";

/** File de relances : factures échues non soldées, dernier niveau et boutons de relance. */
export function OverdueList({ rows, t, locale }: { rows: OverdueInvoice[]; t: Translator; locale: Locale }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{t("invoicing.dunning.empty")}</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="py-2 pr-3">{t("invoicing.number")}</th>
            <th className="py-2 pr-3">{t("invoicing.form.customer")}</th>
            <th className="py-2 pr-3">{t("invoicing.form.dueDate")}</th>
            <th className="py-2 pr-3 text-right">{t("invoicing.dunning.days")}</th>
            <th className="py-2 pr-3 text-right">{t("invoicing.outstanding")}</th>
            <th className="py-2 pr-3">{t("invoicing.dunning.last")}</th>
            <th className="py-2">{t("invoicing.dunning.title")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) => (
            <tr key={r.documentId}>
              <td className="py-1.5 pr-3 font-mono text-xs">
                <Link href={`/invoices/${r.documentId}`} className="underline-offset-2 hover:underline">
                  {r.number}
                </Link>
              </td>
              <td className="py-1.5 pr-3">
                {r.partnerName}
                {typeof r.partnerContact.phone === "string" ? <span className="ml-1 text-xs text-slate-500">{r.partnerContact.phone}</span> : null}
              </td>
              <td className="py-1.5 pr-3">{formatDate(locale, r.dueDate)}</td>
              <td className={`py-1.5 pr-3 text-right ${r.daysOverdue > 90 ? "text-red-700 dark:text-red-300" : r.daysOverdue > 30 ? "text-amber-700 dark:text-amber-300" : ""}`}>{r.daysOverdue}</td>
              <td className="py-1.5 pr-3 text-right"><Money value={r.outstanding} currency={r.currency} /></td>
              <td className="py-1.5 pr-3 text-xs text-slate-500">{r.lastDunningLevel > 0 ? `${t("invoicing.dunning.levelN", { n: r.lastDunningLevel })} · ${formatDate(locale, r.lastDunningAt?.slice(0, 10))}` : "—"}</td>
              <td className="py-1.5">
                <DunningButtons row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
