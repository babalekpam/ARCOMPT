// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n-client";
import type { Account } from "@/lib/types";
import { inputClass } from "@/components/ui/Field";

/**
 * Sélecteur de compte avec recherche (numéro ou libellé) sur le plan de comptes
 * chargé une fois par formulaire. Sans plan disponible, saisie libre du numéro.
 */
export function AccountPicker({ accounts, value, onChange, id }: { accounts: Account[] | null; value: string; onChange: (number: string) => void; id?: string }) {
  const t = useT();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => setQuery(value), [value]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const matches = useMemo(() => {
    if (!accounts) return [];
    const q = query.trim().toLowerCase();
    const postable = accounts.filter((a) => a.postable && a.active);
    if (!q) return postable.slice(0, 30);
    return postable.filter((a) => a.number.startsWith(q) || a.label.toLowerCase().includes(q)).slice(0, 30);
  }, [accounts, query]);

  const selected = accounts?.find((a) => a.number === value);
  const pick = (a: Account) => {
    onChange(a.number);
    setQuery(a.number);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        id={id}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value.trim());
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const a = matches[highlight];
            if (a) pick(a);
          } else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={accounts ? t("entries.form.searchAccount") : "6041"}
        aria-label={t("entries.form.account")}
        aria-autocomplete="list"
        aria-expanded={open}
        inputMode="numeric"
        className={`${inputClass} font-mono`}
        autoComplete="off"
      />
      {selected ? <p className="mt-1 truncate text-[11px] text-slate-500">{selected.label}</p> : accounts === null ? <p className="mt-1 text-[11px] text-slate-400">{t("entries.form.accountsUnavailable")}</p> : null}
      {open && accounts ? (
        <ul role="listbox" className="absolute z-30 mt-1 max-h-56 w-[min(22rem,90vw)] overflow-auto rounded-lg border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {matches.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">{t("entries.form.noAccount")}</li> : null}
          {matches.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === highlight} onMouseDown={() => pick(a)} className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${i === highlight ? "bg-slate-100 dark:bg-slate-800" : ""}`}>
              <span className="font-mono text-xs">{a.number}</span>
              <span className="truncate text-slate-600 dark:text-slate-300">{a.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
