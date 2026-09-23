"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Company } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

export function PlatformCompanyList({ companies }: { companies: Company[] }) {
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
      const key = company.organizationName || "Independent companies";
      map.set(key, [...(map.get(key) ?? []), company]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);
  const select = (tenantId: string) => {
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/session/tenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (!response.ok) {
        setError("Company selection failed. Please try again.");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });
  };
  return (
    <section aria-label="All companies">
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search companies or organizations" aria-label="Search companies" />
      <p className="mt-3 text-xs text-slate-500">{filtered.length} {filtered.length === 1 ? "company" : "companies"}</p>
      <div className="mt-3 space-y-5">
        {groups.map(([organization, items]) => (
          <div key={organization}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{organization}</h2>
            <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {items.map((company) => (
                <div key={company.id} className="flex items-center justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{company.name}</p>
                    <p className="text-xs text-slate-500">{company.countryCode ?? "—"} · {company.id}</p>
                  </div>
                  <Button type="button" size="sm" disabled={pending} onClick={() => select(company.id)}>Select</Button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">No companies match your search.</p> : null}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}