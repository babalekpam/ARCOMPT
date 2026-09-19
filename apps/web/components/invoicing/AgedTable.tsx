import type { Translator } from "@/lib/i18n";
import { Money } from "@/components/ui/Money";
import { AGING_BUCKETS, type AgedReport } from "./types";

/** Balance âgée (créances ou dettes) par tiers et tranche de retard ; composant serveur. */
export function AgedTable({ report, t }: { report: AgedReport; t: Translator }) {
  if (report.rows.length === 0) return <p className="text-sm text-slate-500">{t("invoicing.aged.empty")}</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <th className="py-2 pr-3">{t("invoicing.aged.partner")}</th>
            <th className="py-2 pr-3 text-right">{t("invoicing.aged.documents")}</th>
            {AGING_BUCKETS.map((b) => (
              <th key={b} className="py-2 pr-3 text-right">
                {t(`invoicing.aged.bucket.${b}`)}
              </th>
            ))}
            <th className="py-2 text-right">{t("common.total")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {report.rows.map((r) => (
            <tr key={r.partnerId}>
              <td className="py-1.5 pr-3">{r.partnerName}</td>
              <td className="py-1.5 pr-3 text-right text-xs text-slate-500">{r.documents}</td>
              {AGING_BUCKETS.map((b) => (
                <td key={b} className={`py-1.5 pr-3 text-right ${b === "90+" ? "text-red-700 dark:text-red-300" : b === "61-90" ? "text-amber-700 dark:text-amber-300" : ""}`}>
                  <Money value={r.buckets[b]} currency={report.currency} dashForZero />
                </td>
              ))}
              <td className="py-1.5 text-right font-semibold"><Money value={r.total} currency={report.currency} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
            <td className="py-2 pr-3" colSpan={2}>{t("common.total")}</td>
            {AGING_BUCKETS.map((b) => (
              <td key={b} className="py-2 pr-3 text-right">
                <Money value={report.totals[b]} currency={report.currency} dashForZero />
              </td>
            ))}
            <td className="py-2 text-right"><Money value={report.total} currency={report.currency} showCurrency /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
