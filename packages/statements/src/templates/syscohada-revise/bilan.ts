// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { StatementTemplate } from "../../types.js";

/**
 * Bilan SYSCOHADA révisé (système normal). Table de passage indicative :
 * à valider contre le texte officiel par l'expert-comptable référent.
 *
 * Conventions : les termes :D ne retiennent que les soldes débiteurs, :C les
 * soldes créditeurs ; un compte de tiers passe ainsi automatiquement du bon
 * côté du bilan (client créditeur → passif, fournisseur débiteur → actif).
 */
export const BILAN_ACTIF: StatementTemplate = {
  code: "BILAN_ACTIF",
  title: "Bilan – Actif",
  lines: [
    { code: "AD", label: "IMMOBILISATIONS INCORPORELLES", style: "subtotal", sum: ["AE", "AF", "AG", "AH"], note: "3A" },
    { code: "AE", label: "Frais de développement et de prospection", note: "3A", brut: ["+211"], amort_prov: ["+2811:C", "+2911:C"] },
    { code: "AF", label: "Brevets, licences, logiciels et droits similaires", note: "3A", brut: ["+212", "+213", "+214"], amort_prov: ["+2812:C", "+2813:C", "+2814:C", "+2912:C", "+2913:C", "+2914:C"] },
    { code: "AG", label: "Fonds commercial et droit au bail", note: "3A", brut: ["+215", "+216"], amort_prov: ["+2815:C", "+2816:C", "+2915:C", "+2916:C"] },
    { code: "AH", label: "Autres immobilisations incorporelles", note: "3A", brut: ["+217", "+218", "+219"], amort_prov: ["+2817:C", "+2818:C", "+2819:C", "+2917:C", "+2918:C", "+2919:C"] },
    { code: "AI", label: "IMMOBILISATIONS CORPORELLES", style: "subtotal", sum: ["AJ", "AK", "AL", "AM", "AN"], note: "3A" },
    { code: "AJ", label: "Terrains (dont placement en net)", note: "3A", brut: ["+22"], amort_prov: ["+282:C", "+292:C"] },
    { code: "AK", label: "Bâtiments", note: "3A", brut: ["+231", "+232", "+233", "+237"], amort_prov: ["+2831:C", "+2832:C", "+2833:C", "+2837:C", "+2931:C", "+2932:C", "+2933:C", "+2937:C"] },
    { code: "AL", label: "Aménagements, agencements et installations", note: "3A", brut: ["+234", "+235", "+238", "+239"], amort_prov: ["+2834:C", "+2835:C", "+2838:C", "+2839:C", "+2934:C", "+2935:C", "+2938:C", "+2939:C"] },
    { code: "AM", label: "Matériel, mobilier et actifs biologiques", note: "3A", brut: ["+241", "+242", "+243", "+244", "+246", "+247", "+248", "+249"], amort_prov: ["+2841:C", "+2842:C", "+2843:C", "+2844:C", "+2846:C", "+2847:C", "+2848:C", "+2849:C", "+2941:C", "+2942:C", "+2943:C", "+2944:C", "+2946:C", "+2947:C", "+2948:C", "+2949:C"] },
    { code: "AN", label: "Matériel de transport", note: "3A", brut: ["+245"], amort_prov: ["+2845:C", "+2945:C"] },
    { code: "AP", label: "AVANCES ET ACOMPTES VERSÉS SUR IMMOBILISATIONS", note: "3A", brut: ["+25"], amort_prov: ["+295:C"] },
    { code: "AQ", label: "IMMOBILISATIONS FINANCIÈRES", style: "subtotal", sum: ["AR", "AS"], note: 4 },
    { code: "AR", label: "Titres de participation", note: 4, brut: ["+26"], amort_prov: ["+296:C"] },
    { code: "AS", label: "Autres immobilisations financières", note: 4, brut: ["+27"], amort_prov: ["+297:C"] },
    { code: "AZ", label: "TOTAL ACTIF IMMOBILISÉ", style: "total", sum: ["AD", "AI", "AP", "AQ"] },
    { code: "BA", label: "ACTIF CIRCULANT HAO", note: 5, brut: ["+48:D"], amort_prov: ["+498:C"] },
    { code: "BB", label: "STOCKS ET ENCOURS", note: 6, brut: ["+31", "+32", "+33", "+34", "+35", "+36", "+37", "+38"], amort_prov: ["+39:C"] },
    { code: "BG", label: "CRÉANCES ET EMPLOIS ASSIMILÉS", style: "subtotal", sum: ["BH", "BI", "BJ"] },
    { code: "BH", label: "Fournisseurs, avances versées", note: 8, brut: ["+40:D"], amort_prov: ["+490:C"] },
    { code: "BI", label: "Clients", note: 7, brut: ["+41:D"], amort_prov: ["+491:C"] },
    {
      code: "BJ",
      label: "Autres créances",
      note: 8,
      brut: ["+42:D", "+43:D", "+44:D", "+45:D", "+461:D", "+462:D", "+463:D", "+465:D", "+466:D", "+467:D", "+471:D", "+472:D", "+474:D", "+475:D", "+476:D", "+477:D"],
      amort_prov: ["+492:C", "+493:C", "+494:C", "+495:C", "+496:C", "+497:C"],
    },
    { code: "BK", label: "TOTAL ACTIF CIRCULANT", style: "total", sum: ["BA", "BB", "BG"] },
    { code: "BQ", label: "Titres de placement", note: 9, brut: ["+50"], amort_prov: ["+590:C"] },
    { code: "BR", label: "Valeurs à encaisser", note: 10, brut: ["+51"], amort_prov: ["+591:C"] },
    { code: "BS", label: "Banques, chèques postaux, caisse et assimilés", note: 11, brut: ["+52:D", "+53:D", "+54:D", "+57:D", "+58:D"], amort_prov: ["+592:C", "+593:C", "+594:C"] },
    { code: "BT", label: "TOTAL TRÉSORERIE-ACTIF", style: "total", sum: ["BQ", "BR", "BS"] },
    { code: "BU", label: "Écart de conversion-Actif", note: 12, brut: ["+478:D"] },
    { code: "BZ", label: "TOTAL GÉNÉRAL", style: "total", sum: ["AZ", "BK", "BT", "BU"] },
  ],
};

/** Passif : la valeur d'un poste est le solde créditeur (C − D) ; "-16" = C − D du compte 16. */
export const BILAN_PASSIF: StatementTemplate = {
  code: "BILAN_PASSIF",
  title: "Bilan – Passif",
  lines: [
    { code: "CA", label: "Capital", note: 13, formula: ["-101", "-102", "-103", "-104"] },
    { code: "CB", label: "Apporteurs, capital non appelé (−)", note: 13, formula: ["-109"] },
    { code: "CD", label: "Primes liées au capital social", note: 14, formula: ["-105"] },
    { code: "CE", label: "Écarts de réévaluation", note: "3E", formula: ["-106"] },
    { code: "CF", label: "Réserves indisponibles", note: 14, formula: ["-111", "-112", "-113"] },
    { code: "CG", label: "Réserves libres", note: 14, formula: ["-118"] },
    { code: "CH", label: "Report à nouveau (+ ou −)", note: 14, formula: ["-12"] },
    {
      code: "CJ",
      label: "Résultat net de l'exercice (bénéfice + ou perte −)",
      // Avant affectation : produits (7, 8x) − charges (6, 8x) ; après clôture : compte 13.
      formula: ["-13", "-6", "-7", "-8"],
    },
    { code: "CL", label: "Subventions d'investissement", note: 15, formula: ["-14"] },
    { code: "CM", label: "Provisions réglementées", note: 15, formula: ["-15"] },
    { code: "CP", label: "TOTAL CAPITAUX PROPRES ET RESSOURCES ASSIMILÉES", style: "total", sum: ["CA", "CB", "CD", "CE", "CF", "CG", "CH", "CJ", "CL", "CM"] },
    { code: "DA", label: "Emprunts et dettes financières diverses", note: "16A", formula: ["-16", "-18"] },
    { code: "DB", label: "Dettes de location-acquisition", note: "16A", formula: ["-17"] },
    { code: "DC", label: "Provisions pour risques et charges", note: "16A", formula: ["-19"] },
    { code: "DD", label: "TOTAL DETTES FINANCIÈRES ET RESSOURCES ASSIMILÉES", style: "total", sum: ["DA", "DB", "DC"] },
    { code: "DF", label: "TOTAL RESSOURCES STABLES", style: "total", sum: ["CP", "DD"] },
    { code: "DH", label: "Dettes circulantes HAO", note: 19, formula: ["+48:C"] },
    { code: "DI", label: "Clients, avances reçues", note: 19, formula: ["+41:C"] },
    { code: "DJ", label: "Fournisseurs d'exploitation", note: 17, formula: ["+40:C"] },
    { code: "DK", label: "Dettes fiscales et sociales", note: 18, formula: ["+42:C", "+43:C", "+44:C"] },
    {
      code: "DM",
      label: "Autres dettes",
      note: 19,
      formula: ["+45:C", "+461:C", "+462:C", "+463:C", "+465:C", "+466:C", "+467:C", "+471:C", "+472:C", "+474:C", "+475:C", "+476:C", "+477:C"],
    },
    { code: "DN", label: "Provisions pour risques à court terme", note: 19, formula: ["-499", "-599"] },
    { code: "DP", label: "TOTAL PASSIF CIRCULANT", style: "total", sum: ["DH", "DI", "DJ", "DK", "DM", "DN"] },
    { code: "DQ", label: "Banques, crédits d'escompte", note: 20, formula: ["-564", "-565"] },
    { code: "DR", label: "Banques, établissements financiers et crédits de trésorerie", note: 20, formula: ["-561", "-566", "+52:C", "+53:C", "+54:C", "+57:C", "+58:C"] },
    { code: "DT", label: "TOTAL TRÉSORERIE-PASSIF", style: "total", sum: ["DQ", "DR"] },
    { code: "DV", label: "Écart de conversion-Passif", note: 12, formula: ["+479:C"] },
    { code: "DZ", label: "TOTAL GÉNÉRAL", style: "total", sum: ["DF", "DP", "DT", "DV"] },
  ],
};
