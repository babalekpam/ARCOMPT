// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n-client";
import { Select } from "@/components/ui/Field";

export interface FilterField {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

/** Filtres de liste portés par l'URL (`?kind=&status=`) : un select par champ, « Tous » pour vider. */
export function ListFilters({ fields }: { fields: FilterField[] }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (name: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      {fields.map((f) => (
        <label key={f.name} className="text-xs text-slate-500">
          {f.label}
          <Select value={params.get(f.name) ?? ""} onChange={(e) => set(f.name, e.target.value)} className="mt-1 min-w-[10rem]">
            <option value="">{t("common.all")}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
      ))}
    </div>
  );
}
