"use client";

import { useMemo, useState } from "react";
import type { PlatformOverview as Overview } from "@/lib/platform-overview";
import { filterPlatformOrganizations } from "@/lib/platform-overview";
import { PlatformCompanyList } from "@/components/platform/PlatformCompanyList";
import { PlanChanger } from "@/components/platform/PlanChanger";
import { Input } from "@/components/ui/Field";
import "./platform.css";

const number = (value: number) => value.toLocaleString("fr-FR");
const kinds: Record<string, string> = { COMPANY: "Entreprise", FIRM: "Cabinet", GROUP: "Groupe" };

export function PlatformOverview({ overview }: { overview: Overview }) {
  const [query, setQuery] = useState("");
  const organizations = useMemo(() => filterPlatformOrganizations(overview.organizations, query), [overview.organizations, query]);
  const stats = [
    ["Organisations clientes", overview.totals.organizations],
    ["Dossiers comptables", overview.totals.companies],
    ["Utilisateurs", overview.totals.users],
    ["Utilisateurs actifs", overview.totals.activeUsers],
    ["Utilisateurs suspendus", overview.totals.suspendedUsers],
  ] as const;
  return (
    <div className="platform-overview space-y-6">
      <section aria-label="Statistiques opérationnelles">
        <dl className="platform-stats">
          {stats.map(([label, value]) => (
            <div key={label} className="platform-stat rounded-xl">
              <dt className="text-sm">{label}</dt>
              <dd className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{number(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          Données opérationnelles actuelles, hors organisation interne. « Actif » signifie non suspendu, pas connecté.
          Aucun montant comptable ni revenu n’est agrégé entre dossiers.
        </p>
      </section>
      <section id="organizations" className="platform-directory" aria-labelledby="platform-directory">
        <div className="mb-4">
          <h2 id="platform-directory" className="text-xl font-semibold">Organisations et dossiers</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Toutes les organisations clientes, y compris celles sans dossier.</p>
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Organisation, dossier, pays ou identifiant…" aria-label="Rechercher une organisation ou un dossier" />
        <p role="status" className="mt-3 text-xs text-slate-600 dark:text-slate-400">{number(organizations.length)} organisation(s) affichée(s)</p>
        <div className="mt-4 space-y-5">
          {organizations.map((org) => (
            <article key={org.id} className="platform-organization overflow-hidden rounded-xl border">
              <div className="platform-organization-header border-b p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="break-words font-semibold">{org.name}</h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300">{kinds[org.kind] ?? org.kind} · Offre {org.plan}</p>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{number(org.users)} utilisateur(s) · {number(org.activeUsers)} actif(s) · {number(org.suspendedUsers)} suspendu(s)</p>
                <p className="mt-1 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">{org.id}</p>
                <PlanChanger organizationId={org.id} currentPlan={org.plan} />
              </div>
              <div className="p-4">
                {org.companies.length ? <PlatformCompanyList companies={org.companies} compact /> : <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">Aucun dossier comptable dans cette organisation.</p>}
              </div>
            </article>
          ))}
          {!organizations.length && <div className="rounded-xl border border-dashed border-slate-300 px-5 py-10 text-center dark:border-slate-700">
            <h3 className="font-semibold">{overview.organizations.length ? "Aucun résultat" : "Aucune organisation cliente"}</h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{overview.organizations.length ? "Essayez un autre nom, pays ou identifiant." : "Les organisations apparaîtront ici une fois créées."}</p>
            {query && <button type="button" onClick={() => setQuery("")} className="mt-4 text-sm font-medium text-sky-700 underline dark:text-sky-300">Effacer la recherche</button>}
          </div>}
        </div>
      </section>
    </div>
  );
}
