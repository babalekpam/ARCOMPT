import type { Metadata } from "next";
import Link from "next/link";
import { PLANS, formatCfa } from "@/lib/plans";
import { getAuthContext } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Tarifs — ARCOMPT",
  description:
    "Les offres ARCOMPT pour les PME et les cabinets d'expertise comptable de l'espace OHADA : comptabilité, facturation, paie et multi-dossiers, en francs CFA.",
};

export default async function PricingPage() {
  // Un visiteur connecté ne doit jamais se sentir éjecté de l'application :
  // le retour le ramène à son tableau de bord, pas à la page marketing.
  let signedIn = false;
  try {
    signedIn = (await getAuthContext()) !== null;
  } catch {
    signedIn = false;
  }
  return (
    <main className="min-h-screen bg-[#F7F5F0] text-slate-900">
      <div className="mx-auto w-full max-w-5xl px-6 py-12">
        {signedIn ? (
          <Link href="/dashboard" className="text-sm font-medium text-slate-600 underline-offset-4 hover:underline">
            ← Retour à l’application
          </Link>
        ) : (
          <Link href="/" className="text-sm font-medium text-slate-600 underline-offset-4 hover:underline">
            ← Retour à l’accueil
          </Link>
        )}
        <h1 className="mt-8 text-3xl font-semibold tracking-tight">Des tarifs simples, en francs CFA</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-slate-600">
          Un prix par dossier comptable et par mois pour les entreprises, un forfait unique pour les cabinets,
          sans frais cachés. Les prix sont identiques en XOF et en XAF.
          L’abonnement annuel fait bénéficier de deux mois offerts.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => (
            <article
              key={plan.code}
              className={`flex flex-col rounded-2xl border bg-white p-6 ${plan.highlighted ? "border-teal-600 shadow-lg ring-1 ring-teal-600" : "border-slate-200"}`}
            >
              {plan.highlighted ? (
                <p className="mb-3 w-fit rounded-full bg-teal-700 px-2.5 py-0.5 text-xs font-semibold text-white">Le plus choisi</p>
              ) : null}
              <h2 className="text-lg font-semibold">{plan.label}</h2>
              <p className="mt-3">
                <span className="text-2xl font-bold tracking-tight">{plan.price === 0 ? "Gratuit" : formatCfa(plan.price)}</span>
                {plan.price > 0 ? <span className="mt-1 block text-xs text-slate-500">{plan.flat ? "par cabinet et par mois" : "par dossier et par mois"}</span> : null}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{plan.tagline}</p>
              <ul className="mt-5 flex-1 space-y-2 text-sm text-slate-700">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span aria-hidden className="text-teal-700">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/sign-up"
                className={`mt-6 rounded-lg px-4 py-2.5 text-center text-sm font-semibold ${plan.highlighted ? "bg-teal-700 text-white hover:bg-teal-800" : "border border-slate-300 hover:bg-slate-50"}`}
              >
                {plan.code === "TRIAL" ? "Commencer l’essai" : "Créer un compte"}
              </Link>
            </article>
          ))}
        </div>
        <section className="mt-12 space-y-4 text-sm leading-relaxed text-slate-600">
          <p>
            <strong className="text-slate-900">Cabinets :</strong> le forfait Cabinet est un prix unique de 75 000 FCFA
            par mois pour tout le cabinet, quel que soit le nombre de dossiers : dossiers illimités et 10 utilisateurs inclus.
          </p>
          <p>
            <strong className="text-slate-900">Changement d’offre :</strong> vous pouvez monter ou descendre d’offre à tout
            moment ; contactez-nous et nous appliquons le changement immédiatement, sans perte de données.
          </p>
          <p>
            Une question, un besoin particulier (formation, reprise de données, volume important) ? Écrivez à{" "}
            <a href="mailto:info@arcompt.com" className="underline-offset-4 hover:underline">info@arcompt.com</a>.
          </p>
        </section>
        <footer className="mt-14 border-t border-slate-200 pt-6 text-sm text-slate-500">
          ARCOMPT — un service ARGILETTE.{" "}
          <Link href="/privacy" className="underline-offset-4 hover:underline">Politique de confidentialité</Link>
        </footer>
      </div>
    </main>
  );
}
