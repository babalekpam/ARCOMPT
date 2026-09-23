// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import type { ComputedNote } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { Money } from "@/components/ui/Money";

export async function NotesList({ notes, currency }: { notes: ComputedNote[]; currency: string }) {
  const { t, locale } = await getT();
  return (
    <div className="space-y-3">
      {notes.map((n) => (
        <details key={String(n.number)} className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm">
            <span className="font-mono text-xs text-slate-500">Note {n.number}</span>
            <span className="flex-1 font-medium">
              {n.title}
              {locale === "en" && n.titleEn ? <span className="ml-2 text-xs font-normal italic text-slate-500 dark:text-slate-400">{n.titleEn}</span> : null}
            </span>
            <Badge tone="neutral">{t(`statements.noteKind.${n.kind}`)}</Badge>
            <Badge tone={n.status === "COMPUTED" ? "success" : "warning"}>{t(`statements.noteStatus.${n.status}`)}</Badge>
            {n.reconciles ? <Badge tone={n.reconciles.ok ? "success" : "danger"}>{n.reconciles.ok ? t("statements.reconciles", { code: n.reconciles.code }) : t("statements.reconcileKo", { code: n.reconciles.code })}</Badge> : null}
            <Money value={n.total} currency={currency} className="font-semibold" />
          </summary>
          <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            {n.rows.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1 text-left">{t("common.label")}</th>
                    <th className="py-1 text-right">{t("common.n")}</th>
                    <th className="py-1 text-right">{t("common.n1")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {n.rows.map((r, i) => (
                    <tr key={`${r.code ?? ""}-${i}`}>
                      <td className="py-1">{(locale === "en" ? r.labelEn : undefined) ?? r.label}</td>
                      <td className="py-1 text-right"><Money value={r.amount} currency={currency} dashForZero /></td>
                      <td className="py-1 text-right text-slate-500"><Money value={r.previous} currency={currency} dashForZero /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-300 font-semibold dark:border-slate-700">
                    <td className="py-1">{t("common.total")}</td>
                    <td className="py-1 text-right"><Money value={n.total} currency={currency} /></td>
                    <td className="py-1 text-right text-slate-500"><Money value={n.previousTotal} currency={currency} /></td>
                  </tr>
                </tfoot>
              </table>
            ) : null}
            {n.outline && n.outline.length > 0 ? (
              <div className="mt-3 text-sm">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("statements.outline")}</p>
                <ol className="list-decimal space-y-0.5 pl-5 text-slate-600 dark:text-slate-300">
                  {n.outline.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}
