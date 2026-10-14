"use client";

// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { useEffect, useState } from "react";
import Link from "next/link";
import { PLANS, formatCfa } from "@/lib/plans";
import { apiClient } from "@/lib/api-client";

interface EntitlementsView {
  planCode: string;
  label: string;
}

/**
 * Les offres, vues depuis l'application : l'utilisateur compare sans jamais
 * quitter son espace de travail (la page publique /pricing reste réservée
 * aux visiteurs). Le changement d'offre se fait par contact ou par
 * l'administrateur de la plateforme.
 */
export default function SettingsOffersPage() {
  const [current, setCurrent] = useState<EntitlementsView | null>(null);
  useEffect(() => {
    apiClient<EntitlementsView>("/portal/org/entitlements").then(setCurrent).catch(() => { /* page informative */ });
  }, []);
  return (
    <div className="mx-auto max-w-5xl py-6">
      <Link href="/settings" className="text-sm font-medium text-slate-600 underline-offset-4 hover:underline dark:text-slate-300">
        ← Retour aux paramètres
      </Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Les offres ARCOMPT</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Un prix par dossier comptable et par mois pour les entreprises, un forfait unique pour les cabinets,
        sans frais cachés. Les prix sont identiques en XOF et en XAF. L’abonnement annuel fait bénéficier de deux mois offerts.
      </p>
      {current ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          Votre offre actuelle : <strong>{current.label}</strong>
        </p>
      ) : null}
      <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => {
          const isCurrent = current?.planCode === plan.code;
          return (
            <article
              key={plan.code}
              className={`flex flex-col rounded-2xl border bg-white p-6 dark:bg-slate-900 ${isCurrent ? "border-teal-600 shadow-lg ring-1 ring-teal-600" : plan.highlighted ? "border-teal-600/50" : "border-slate-200 dark:border-slate-700"}`}
            >
              {isCurrent ? (
                <span className="mb-3 inline-flex w-fit rounded-full bg-teal-700 px-2.5 py-1 text-[11px] font-semibold text-white">Votre offre actuelle</span>
              ) : plan.highlighted ? (
                <span className="mb-3 inline-flex w-fit rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-800 dark:bg-teal-950 dark:text-teal-200">Le plus choisi</span>
              ) : null}
              <h2 className="text-base font-semibold">{plan.label}</h2>
              <p className="mt-2">
                <span className="text-2xl font-bold tracking-tight">{plan.price === 0 ? "Gratuit" : formatCfa(plan.price)}</span>
              </p>
              <p className="text-xs text-slate-500">{plan.flat ? "par cabinet et par mois" : plan.price === 0 ? "14 jours, sans carte bancaire" : "par dossier et par mois"}</p>
              <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{plan.tagline}</p>
              <ul className="mt-4 flex flex-col gap-2 text-sm text-slate-700 dark:text-slate-200">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span aria-hidden className="text-teal-700 dark:text-teal-300">✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
      <p className="mt-8 text-sm text-slate-600 dark:text-slate-300">
        Pour changer d’offre, écrivez à <a href="mailto:info@arcompt.com" className="font-medium text-teal-700 underline dark:text-teal-300">info@arcompt.com</a> :
        le changement est appliqué à votre organisation, sans perte de données.
      </p>
    </div>
  );
}
