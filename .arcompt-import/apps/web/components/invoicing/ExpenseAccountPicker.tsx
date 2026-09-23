// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { Account } from "@/lib/types";
import { inputClass } from "@/components/ui/Field";

/**
 * Sélecteur de compte de charge (classe 6) ou d'immobilisation (classe 2) :
 * recherche serveur `GET /v1/accounts?q=` (numéro ou libellé), filtrée aux
 * classes autorisées. La saisie libre d'un numéro reste possible.
 */
export function ExpenseAccountPicker({ value, onChange, classes = [6, 2] }: { value: string; onChange: (number: string) => void; classes?: number[] }) {
  const t = useT();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<Account[]>([]);
  const [label, setLabel] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const classesKey = classes.join(",");

  useEffect(() => setQuery(value), [value]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      apiClient<{ accounts: Account[] }>("/accounts", { query: { q: query.trim() || undefined, postable: "true" } })
        .then((d) => {
          const allowed = classesKey.split(",").map(Number);
          const rows = d.accounts.filter((a) => allowed.includes(a.class)).slice(0, 30);
          setMatches(rows);
          const exact = d.accounts.find((a) => a.number === query.trim());
          setLabel(exact ? exact.label : null);
        })
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open, classesKey]);

  const pick = (a: Account) => {
    onChange(a.number);
    setQuery(a.number);
    setLabel(a.label);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value.trim());
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={t("invoicing.expense.accountPlaceholder")}
        aria-label={t("common.account")}
        aria-autocomplete="list"
        aria-expanded={open}
        inputMode="numeric"
        className={`${inputClass} font-mono`}
        autoComplete="off"
      />
      {label ? <p className="mt-1 truncate text-[11px] text-slate-500">{label}</p> : null}
      {open ? (
        <ul role="listbox" className="absolute z-30 mt-1 max-h-56 w-[min(22rem,90vw)] overflow-auto rounded-lg border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {matches.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">{t("invoicing.expense.noAccount")}</li> : null}
          {matches.map((a) => (
            <li key={a.id} role="option" aria-selected={a.number === value} onMouseDown={() => pick(a)} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
              <span className="font-mono text-xs">{a.number}</span>
              <span className="truncate text-slate-600 dark:text-slate-300">{a.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
