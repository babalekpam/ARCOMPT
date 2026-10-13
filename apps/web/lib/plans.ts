// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary

/** Catalogue commercial public (miroir de subscription_plan, migration 0037). */
export interface PlanInfo {
  code: string;
  label: string;
  /** Prix par dossier et par mois, en FCFA (XOF/XAF, même parité). */
  price: number;
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

export const PLAN_CODES = ["TRIAL", "ESSENTIEL", "PRO", "CABINET"] as const;

export const PLANS: PlanInfo[] = [
  {
    code: "TRIAL",
    label: "Essai",
    price: 0,
    tagline: "14 jours pour tout essayer, sans carte bancaire.",
    features: ["Toutes les fonctions de l'offre Pro", "1 dossier comptable", "Jusqu'à 5 utilisateurs", "Sans engagement"],
  },
  {
    code: "ESSENTIEL",
    label: "Essentiel",
    price: 9900,
    tagline: "La comptabilité et la facturation des très petites entreprises.",
    features: ["Comptabilité OHADA complète", "Devis, factures et règlements", "1 utilisateur", "Documents et exports"],
  },
  {
    code: "PRO",
    label: "Pro",
    price: 24900,
    tagline: "Pour les PME qui veulent la paie et l'assistance intelligente.",
    features: ["Tout l'Essentiel", "Paie complète (bulletins, cotisations, impôts)", "Assistant IA et capture de documents", "Jusqu'à 5 utilisateurs"],
    highlighted: true,
  },
  {
    code: "CABINET",
    label: "Cabinet",
    price: 7500,
    tagline: "Pour les cabinets qui gèrent les dossiers de leurs clients.",
    features: ["Tout le Pro, tarif dégressif selon le volume", "Tableau de bord multi-dossiers", "Marque blanche (votre logo, vos couleurs)", "Jusqu'à 10 utilisateurs"],
  },
];

export function formatCfa(value: number): string {
  return `${value.toLocaleString("fr-FR")} FCFA`;
}

export function planLabel(code: string): string {
  return PLANS.find((p) => p.code === code)?.label ?? code;
}
