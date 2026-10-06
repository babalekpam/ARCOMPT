"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Company } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

export function PlatformCompanyList({ companies, compact = false }: { companies: Company[]; compact?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((c) => !q || [c.name, c.organizationName, c.countryCode].some((v) => v?.toLowerCase().includes(q)));
  }, [companies, query]);
  const groups = useMemo(() => {
    const map = new Map<string, Company[]>();
    for (const company of filtered) {
      const key = company.organizationId || "independent";
      map.set(key, [...(map.get(key) ?? []), company]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);
  const select = (tenantId: string) => {
    setError(null);
    startTransition(async () => {
      try {
      const response = await fetch("/api/session/tenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (!response.ok) {
        setError("Sélection du dossier impossible. Réessayez.");
        return;
      }
      router.push("/dashboard");
      router.refresh();
      } catch { setError("Le service est indisponible. Réessayez la sélection du dossier."); }
    });
  };
  return (
    <section aria-label="Dossiers comptables">
      {!compact && <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un dossier ou une organisation" aria-label="Rechercher un dossier" />}
      {!compact && <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{filtered.length} dossier(s)</p>}
      <div className={compact ? "space-y-3" : "mt-3 space-y-5"}>
        {groups.map(([organization, items]) => (
          <div key={organization}>
            {!compact && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{items[0]?.organizationName || "Dossiers indépendants"}</h2>}
            <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {items.map((company) => (
                <div key={company.id} className="flex items-center justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{company.name}</p>
                    <p className="break-all text-xs text-slate-500 dark:text-slate-400">{company.countryCode ?? "—"} · {company.id}</p>
                  </div>
                  <Button type="button" size="sm" className="shrink-0" disabled={pending} onClick={() => select(company.id)}>{pending ? "Patientez…" : "Ouvrir"}</Button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 ? <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">Aucun dossier ne correspond à votre recherche.</p> : null}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}