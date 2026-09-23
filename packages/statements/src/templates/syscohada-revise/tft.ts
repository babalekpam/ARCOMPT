// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { StatementTemplate } from "../../types.js";

/**
 * Tableau des flux de trésorerie SYSCOHADA révisé (méthode indirecte).
 *
 * Chaque flux est exprimé en variations de balance N / N-1 et en mouvements
 * de l'exercice (:DM débits, :CM crédits), de sorte que l'identité
 * « variation de trésorerie = ZB + ZC + ZF » tient par construction quand
 * chaque compte de bilan est repris par exactement un flux. Un écart signale
 * une écriture atypique (à retraiter à la main) et bloque la publication.
 *
 * Convention de signe : "-16" = C − D en N ; "+prev:16" = D − C en N-1 ;
 * la somme des deux est la variation du solde créditeur de l'emprunt.
 *
 * Table de passage indicative, à valider par l'expert-comptable référent.
 */
const cash = ["50", "51", "52", "53", "54", "56", "57", "58", "59"];

export const TFT: StatementTemplate = {
  code: "TFT",
  title: "Tableau des flux de trésorerie",
  lines: [
    { code: "ZA", label: "Trésorerie nette au 1er janvier (Trésorerie actif N-1 − trésorerie passif N-1)", style: "subtotal", formula: cash.map((c) => `+prev:${c}`) },
    {
      code: "FA",
      label: "Capacité d'Autofinancement Globale (CAFG)",
      // Résultat net + dotations − reprises + valeurs comptables des cessions − produits des cessions.
      formula: ["-6", "-7", "-8", "+681", "+687", "+691", "+697", "+85", "+791", "+797", "+798", "+86", "+81", "+82", "+654", "+754"],
    },
    { code: "FB", label: "Variation de l'actif circulant HAO", formula: ["-48:D", "+prev:48:D"] },
    { code: "FC", label: "Variation des stocks", formula: ["-3", "+prev:3"] },
    {
      code: "FD",
      label: "Variation des créances et emplois assimilés",
      formula: [
        "-40:D", "+prev:40:D", "-41:D", "+prev:41:D", "-42:D", "+prev:42:D", "-43:D", "+prev:43:D", "-44:D", "+prev:44:D", "-45:D", "+prev:45:D",
        "-461:D", "+prev:461:D", "-462:D", "+prev:462:D", "-463:D", "+prev:463:D", "-466:D", "+prev:466:D", "-467:D", "+prev:467:D",
        "-47:D", "+prev:47:D",
        "-490", "+prev:490", "-491", "+prev:491", "-492", "+prev:492", "-493", "+prev:493", "-494", "+prev:494", "-495", "+prev:495", "-496", "+prev:496", "-497", "+prev:497", "-498", "+prev:498",
      ],
    },
    {
      code: "FE",
      label: "Variation du passif circulant",
      formula: [
        "+40:C", "-prev:40:C", "+41:C", "-prev:41:C", "+42:C", "-prev:42:C", "+43:C", "-prev:43:C", "+44:C", "-prev:44:C", "+45:C", "-prev:45:C",
        "+461:C", "-prev:461:C", "+462:C", "-prev:462:C", "+463:C", "-prev:463:C", "+466:C", "-prev:466:C", "+467:C", "-prev:467:C",
        "+47:C", "-prev:47:C", "+48:C", "-prev:48:C", "-499", "+prev:499",
      ],
    },
    { code: "ZB", label: "Flux de trésorerie provenant des activités opérationnelles", style: "total", sum: ["FA", "FB", "FC", "FD", "FE"] },
    { code: "FF", label: "Décaissements liés aux acquisitions d'immobilisations incorporelles", formula: ["-21", "+prev:21", "-21:CM"] },
    {
      code: "FG",
      label: "Décaissements liés aux acquisitions d'immobilisations corporelles",
      formula: ["-22", "+prev:22", "-22:CM", "-23", "+prev:23", "-23:CM", "-24", "+prev:24", "-24:CM", "-25", "+prev:25", "-25:CM"],
    },
    { code: "FH", label: "Décaissements liés aux acquisitions d'immobilisations financières", formula: ["-26", "+prev:26", "-26:CM", "-27", "+prev:27", "-27:CM"] },
    { code: "FI", label: "Encaissements liés aux cessions d'immobilisations incorporelles et corporelles", formula: ["-821", "-822", "-754"] },
    { code: "FJ", label: "Encaissements liés aux cessions d'immobilisations financières", formula: ["-826"] },
    { code: "ZC", label: "Flux de trésorerie provenant des activités d'investissement", style: "total", sum: ["FF", "FG", "FH", "FI", "FJ"] },
    {
      code: "FK",
      label: "Augmentations de capital par apports nouveaux (nettes des prélèvements)",
      // Variation des capitaux propres hors résultat N, neutralisée du résultat N-1 repris en à-nouveaux,
      // augmentée des dividendes décidés (repris en FN une fois payés).
      formula: ["-10", "+prev:10", "-11", "+prev:11", "-12", "+prev:12", "-13", "+prev:13", "+prev:6", "+prev:7", "+prev:8", "-465", "+prev:465", "+465:DM"],
    },
    { code: "FL", label: "Subventions d'investissement reçues", formula: ["-14", "+prev:14", "-865"] },
    { code: "FN", label: "Dividendes versés", formula: ["-465:DM"] },
    { code: "ZD", label: "Flux de trésorerie provenant des capitaux propres", style: "total", sum: ["FK", "FL", "FN"] },
    { code: "FO", label: "Emprunts", formula: ["-16", "+prev:16", "+16:DM"] },
    { code: "FP", label: "Autres dettes financières", formula: ["-17", "+prev:17", "+17:DM", "-18", "+prev:18", "+18:DM"] },
    { code: "FQ", label: "Remboursements des emprunts et autres dettes financières", formula: ["-16:DM", "-17:DM", "-18:DM"] },
    { code: "ZE", label: "Flux de trésorerie provenant des capitaux étrangers", style: "total", sum: ["FO", "FP", "FQ"] },
    { code: "ZF", label: "Flux de trésorerie provenant des activités de financement", style: "total", sum: ["ZD", "ZE"] },
    { code: "ZG", label: "VARIATION DE LA TRÉSORERIE NETTE DE LA PÉRIODE", style: "total", sum: ["ZB", "ZC", "ZF"] },
    { code: "ZH", label: "Trésorerie nette au 31 décembre (Trésorerie actif N − trésorerie passif N)", style: "total", formula: cash.map((c) => `+${c}`) },
  ],
};
