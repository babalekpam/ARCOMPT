import { getT } from "@/lib/i18n-server";
import type { ComputedStatement } from "@/lib/types";
import { Money } from "@/components/ui/Money";

const rowStyle: Record<string, string> = {
  header: "bg-slate-100 text-xs font-semibold uppercase tracking-wide dark:bg-slate-800/70",
  total: "border-t-2 border-slate-400 bg-slate-50 font-bold dark:border-slate-600 dark:bg-slate-800/50",
  subtotal: "border-t border-slate-300 font-semibold dark:border-slate-700",
  line: "",
};

/** Tableau d'état financier à l'allure officielle : Brut / Amort / Net / N-1 (actif) ou Net / N-1. */
export async function StatementTable({ statement, currency }: { statement: ComputedStatement; currency: string }) {
  const { t } = await getT();
  const hasBrut = statement.lines.some((l) => l.brut !== undefined);
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
      <table className="w-full min-w-[40rem] text-sm">
        <caption className="bg-slate-900 px-4 py-2 text-left text-sm font-semibold text-white dark:bg-slate-100 dark:text-slate-900">{statement.title}</caption>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60">
          <tr>
            <th className="px-3 py-2 text-left">Réf.</th>
            <th className="px-3 py-2 text-left">{t("common.label")}</th>
            <th className="px-2 py-2 text-center">{t("common.note")}</th>
            {hasBrut ? (
              <>
                <th className="px-2 py-2 text-right">{t("statements.brut")}</th>
                <th className="px-2 py-2 text-right">{t("statements.amort")}</th>
              </>
            ) : null}
            <th className="px-2 py-2 text-right">{t("statements.net")}</th>
            <th className="px-3 py-2 text-right">{t("statements.previous")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {statement.lines.map((l) => (
            <tr key={l.code} className={rowStyle[l.style] ?? ""}>
              <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{l.code}</td>
              <td className={`px-3 py-1.5 ${l.style === "line" ? "pl-6" : ""}`}>{l.label}</td>
              <td className="px-2 py-1.5 text-center text-xs text-slate-500">{l.note ?? ""}</td>
              {hasBrut ? (
                <>
                  <td className="px-2 py-1.5 text-right"><Money value={l.brut} currency={currency} dashForZero /></td>
                  <td className="px-2 py-1.5 text-right"><Money value={l.amortProv} currency={currency} dashForZero /></td>
                </>
              ) : null}
              <td className="px-2 py-1.5 text-right"><Money value={l.net} currency={currency} dashForZero colorSign /></td>
              <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-300"><Money value={l.previousNet} currency={currency} dashForZero colorSign /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
