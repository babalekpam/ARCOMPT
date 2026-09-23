// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { getT } from "@/lib/i18n-server";
import { inputClass } from "@/components/ui/Field";

/** Filtres de la balance (formulaire GET : fonctionne sans JavaScript). */
export async function BalanceFilters({ fiscalYear, cls, from, to }: { fiscalYear: string; cls: string; from: string; to: string }) {
  const { t } = await getT();
  return (
    <form method="get" className="flex flex-wrap items-end gap-2 text-xs">
      <label>
        {t("common.fiscalYear")}
        <input name="fy" defaultValue={fiscalYear} className={`${inputClass} mt-1 w-24`} inputMode="numeric" />
      </label>
      <label>
        {t("balance.filterClass")}
        <select name="class" defaultValue={cls} className={`${inputClass} mt-1 w-40`}>
          <option value="">{t("common.all")}</option>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => (
            <option key={c} value={String(c)}>
              {c} — {t(`accounts.class.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("balance.filterFrom")}
        <input type="date" name="from" defaultValue={from} className={`${inputClass} mt-1`} />
      </label>
      <label>
        {t("balance.filterTo")}
        <input type="date" name="to" defaultValue={to} className={`${inputClass} mt-1`} />
      </label>
      <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
        {t("common.apply")}
      </button>
    </form>
  );
}
