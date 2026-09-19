"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n-client";
import { Input } from "@/components/ui/Field";

/** Sélecteur d'exercice (code, ex. 2025) porté par le paramètre d'URL `fy`. */
export function FiscalYearPicker({ value, previous }: { value: string; previous?: string | undefined }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [fy, setFy] = useState(value);
  const [prev, setPrev] = useState(previous ?? "");
  const apply = () => {
    const next = new URLSearchParams(params.toString());
    next.set("fy", fy.trim());
    if (prev.trim()) next.set("prev", prev.trim());
    else next.delete("prev");
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
        {t("common.fiscalYear")}
        <Input value={fy} onChange={(e) => setFy(e.target.value)} className="mt-1 w-24" inputMode="numeric" />
      </label>
      {previous !== undefined ? (
        <label className="text-xs text-slate-500">
          {t("common.n1")}
          <Input value={prev} onChange={(e) => setPrev(e.target.value)} className="mt-1 w-24" inputMode="numeric" placeholder="—" />
        </label>
      ) : null}
      <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
        {t("common.apply")}
      </button>
    </form>
  );
}
