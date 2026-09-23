// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { apiClient } from "@/lib/api-client";
import { useT } from "@/lib/i18n-client";
import type { Company } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sélecteur de dossier : liste `/v1/portal/org/companies` quand le portail
 * existe, sinon saisie manuelle de l'UUID. Le choix est mémorisé en cookie
 * httpOnly (`/api/session/tenant`) et seuls les en-têtes du proxy le portent.
 */
export function CompanySwitcher({ tenantId, platformAdmin = false }: { tenantId: string | null; platformAdmin?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open || companies !== null) return;
    apiClient<{ companies?: Company[] } | Company[]>(platformAdmin ? "/platform/companies" : "/portal/org/companies")
      .then((data) => setCompanies(Array.isArray(data) ? data : (data.companies ?? [])))
      .catch(() => setCompanies([]));
  }, [open, companies]);

  const select = (id: string) => {
    if (!UUID_RE.test(id)) {
      setError(t("login.invalidTenant"));
      return;
    }
    setError(null);
    start(async () => {
      const res = await fetch("/api/session/tenant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: id }) });
      if (!res.ok) {
        setError(t("common.error"));
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  const current = companies?.find((c) => c.id === tenantId);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex max-w-[14rem] items-center gap-2 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" title={t("company.switch")}>
        <span aria-hidden>◫</span>
        <span className="truncate font-mono">{current?.name ?? (tenantId ? `${tenantId.slice(0, 8)}…` : t("company.none"))}</span>
        <span aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-80 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("company.list")}</p>
          {companies === null ? (
            <p className="text-xs text-slate-500">{t("common.loading")}</p>
          ) : companies.length === 0 ? (
            <p className="text-xs text-slate-500">{platformAdmin ? "No companies available." : t("company.manualHint")}</p>
          ) : (
            <ul className="mb-2 max-h-48 overflow-auto">
              {companies.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => select(c.id)} className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${c.id === tenantId ? "font-semibold" : ""}`}>
                    <span className="truncate">{c.name}</span>
                    <span className="ml-2 font-mono text-[10px] text-slate-400">{c.id.slice(0, 8)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!platformAdmin ? <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              select(manual.trim());
            }}
          >
            <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("company.manual")} aria-label={t("company.manual")} className="font-mono text-xs" />
            <Button type="submit" size="sm" disabled={pending}>
              {t("common.apply")}
            </Button>
          </form> : null}
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
