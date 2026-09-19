"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n-client";
import { Input, Select } from "@/components/ui/Field";

/** Sélecteur d'année (et de mois en option) porté par les paramètres d'URL `year` / `month`. */
export function PeriodPicker({ year, month }: { year: number; month?: number }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [y, setY] = useState(String(year));
  const [m, setM] = useState(month === undefined ? "" : String(month));
  const apply = () => {
    const next = new URLSearchParams(params.toString());
    next.set("year", y.trim());
    if (month !== undefined) next.set("month", m);
    router.push(`${pathname}?${next.toString()}`);
  };
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <label className="text-xs text-slate-500">
        {t("payroll.year")}
        <Input value={y} onChange={(e) => setY(e.target.value)} className="mt-1 w-24" inputMode="numeric" />
      </label>
      {month !== undefined ? (
        <label className="text-xs text-slate-500">
          {t("payroll.month")}
          <Select value={m} onChange={(e) => setM(e.target.value)} className="mt-1 w-40">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={String(n)}>
                {t(`payroll.months.${n}`)}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
        {t("common.apply")}
      </button>
    </form>
  );
}
