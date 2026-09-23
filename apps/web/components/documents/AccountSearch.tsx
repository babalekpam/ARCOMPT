// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { Account } from "@/lib/types";
import { inputClass } from "@/components/ui/Field";

/** Sélecteur de compte imputable interrogeant `GET /v1/accounts?q=` (recherche par numéro ou libellé, avec anti-rebond). */
export function AccountSearch({ value, onChange, id }: { value: string; onChange: (accountNumber: string, account?: Account) => void; id?: string }) {
  const t = useT();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const handle = setTimeout(() => {
      setLoading(true);
      apiClient<{ accounts: Account[] }>("/accounts", { query: { q: q || undefined, postable: "true" } })
        .then((d) => setResults(d.accounts.slice(0, 30)))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open]);

  const pick = (a: Account) => {
    onChange(a.number, a);
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
          if (!open || results.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const a = results[highlight];
            if (a) pick(a);
          } else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={t("documents.review.searchAccount")}
        aria-label={t("documents.proposal.account")}
        aria-autocomplete="list"
        aria-expanded={open}
        inputMode="numeric"
        autoComplete="off"
        className={`${inputClass} font-mono`}
      />
      {open ? (
        <ul role="listbox" className="absolute z-30 mt-1 max-h-56 w-[min(22rem,90vw)] overflow-auto rounded-lg border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {loading && results.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">{t("common.loading")}</li> : null}
          {!loading && results.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">{t("documents.review.noAccount")}</li> : null}
          {results.map((a, i) => (
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
