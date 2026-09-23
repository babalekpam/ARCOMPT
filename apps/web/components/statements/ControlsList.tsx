// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import type { Control } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";

export async function ControlsList({ controls, orphanAccounts }: { controls: Control[]; orphanAccounts: string[] }) {
  const { t, locale } = await getT();
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {controls.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
            <Badge tone={c.ok ? "success" : c.severity === "BLOCKING" ? "danger" : "warning"} className="mt-0.5 w-12 justify-center">
              {c.ok ? t("common.ok") : t("common.ko")}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{(locale === "en" ? c.labelEn : undefined) ?? c.label}</span>
                <Badge tone={c.severity === "BLOCKING" ? "danger" : "warning"}>{t(`statements.severity.${c.severity}`)}</Badge>
                <span className="font-mono text-[10px] text-slate-400">{c.id}</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">{(locale === "en" ? c.detailEn : undefined) ?? c.detail}</p>
              {c.expected !== undefined || c.actual !== undefined ? (
                <p className="mt-0.5 font-mono text-xs text-slate-500">
                  {t("statements.expected")} {c.expected ?? "—"} · {t("statements.actual")} {c.actual ?? "—"}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {orphanAccounts.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <p className="font-medium">{t("statements.orphans")}</p>
          <p className="text-xs text-slate-500">{t("statements.orphansHint")}</p>
          <p className="mt-2 font-mono text-xs">{orphanAccounts.join(", ")}</p>
        </div>
      ) : null}
    </div>
  );
}
