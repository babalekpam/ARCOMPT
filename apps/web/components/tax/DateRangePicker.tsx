// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n-client";
import { Input } from "@/components/ui/Field";

/** Sélecteur de plage de dates porté par les paramètres d'URL `from` / `to`. */
export function DateRangePicker({ from, to }: { from: string; to: string }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [f, setF] = useState(from);
  const [tt, setTt] = useState(to);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const next = new URLSearchParams(params.toString());
        next.set("from", f);
        next.set("to", tt);
        router.push(`${pathname}?${next.toString()}`);
      }}
    >
      <label className="text-xs text-slate-500">
        {t("common.from")}
        <Input type="date" value={f} onChange={(e) => setF(e.target.value)} className="mt-1" required />
      </label>
      <label className="text-xs text-slate-500">
        {t("common.to")}
        <Input type="date" value={tt} onChange={(e) => setTt(e.target.value)} className="mt-1" required />
      </label>
      <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
        {t("common.apply")}
      </button>
    </form>
  );
}
