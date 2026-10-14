"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";

interface EntitlementsView {
  label: string;
  planCode: string;
  features: { payroll: boolean };
}

/** La paie est un droit d'offre (Pro et plus) : écran d'explication sinon. */
export default function PayrollLayout({ children }: { children: ReactNode }) {
  const [blockedBy, setBlockedBy] = useState<EntitlementsView | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    apiClient<EntitlementsView>("/portal/org/entitlements")
      .then((e) => { if (!e.features.payroll) setBlockedBy(e); })
      .catch(() => { /* l'API reste la barrière de référence */ })
      .finally(() => setChecked(true));
  }, []);
  // Tant que le droit n'est pas vérifié, ne rien montrer : l'écran d'erreur
  // brut de l'API (« PLAN_UPGRADE_REQUIRED ») ne doit jamais clignoter.
  if (!checked) return <div className="py-10 text-center text-sm text-slate-500">Chargement du module paie…</div>;
  if (blockedBy) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
          <h1 className="text-xl font-semibold">La paie n’est pas incluse dans votre offre</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            Votre organisation est sur l’offre <strong>{blockedBy.label}</strong>. Le module paie (salariés, bulletins,
            cotisations et déclarations) fait partie de l’offre <strong>Pro</strong> et des offres supérieures.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/settings/offers" className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800">Voir les offres</Link>
            <Link href="/settings" className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 dark:border-slate-600">Mon forfait</Link>
          </div>
          <p className="mt-4 text-xs text-slate-500">Changement d’offre : info@arcompt.com</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
