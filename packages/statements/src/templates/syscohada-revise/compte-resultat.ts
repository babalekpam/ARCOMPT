import type { StatementTemplate } from "../../types.js";

/**
 * Compte de résultat SYSCOHADA révisé (système normal), présentation en liste
 * avec soldes intermédiaires de gestion.
 *
 * Convention : chaque poste vaut C − D ("-601"). Les produits ressortent en
 * positif, les charges en négatif, et les soldes sont de simples sommes.
 */
export const COMPTE_RESULTAT: StatementTemplate = {
  code: "COMPTE_RESULTAT",
  title: "Compte de résultat",
  lines: [
    { code: "TA", label: "Ventes de marchandises", note: 21, formula: ["-701"] },
    { code: "RA", label: "Achats de marchandises", note: 22, formula: ["-601"] },
    { code: "RB", label: "Variation de stocks de marchandises", note: 6, formula: ["-6031"] },
    { code: "XA", label: "MARGE COMMERCIALE", style: "subtotal", sum: ["TA", "RA", "RB"] },
    { code: "TB", label: "Ventes de produits fabriqués", note: 21, formula: ["-702", "-703", "-704"] },
    { code: "TC", label: "Travaux, services vendus", note: 21, formula: ["-705", "-706"] },
    { code: "TD", label: "Produits accessoires", note: 21, formula: ["-707"] },
    { code: "XB", label: "CHIFFRE D'AFFAIRES", style: "subtotal", sum: ["TA", "TB", "TC", "TD"] },
    { code: "TE", label: "Production stockée (ou déstockage)", note: 6, formula: ["-73"] },
    { code: "TF", label: "Production immobilisée", note: 21, formula: ["-72"] },
    { code: "TG", label: "Subventions d'exploitation", note: 21, formula: ["-71"] },
    { code: "TH", label: "Autres produits", note: 21, formula: ["-75"] },
    { code: "TI", label: "Transferts de charges d'exploitation", note: 12, formula: ["-781"] },
    { code: "RC", label: "Achats de matières premières et fournitures liées", note: 22, formula: ["-602"] },
    { code: "RD", label: "Variation de stocks de matières premières et fournitures liées", note: 6, formula: ["-6032"] },
    { code: "RE", label: "Autres achats", note: 22, formula: ["-604", "-605", "-608"] },
    { code: "RF", label: "Variation de stocks d'autres approvisionnements", note: 6, formula: ["-6033"] },
    { code: "RG", label: "Transports", note: 23, formula: ["-61"] },
    { code: "RH", label: "Services extérieurs", note: 24, formula: ["-62", "-63"] },
    { code: "RI", label: "Impôts et taxes", note: 25, formula: ["-64"] },
    { code: "RJ", label: "Autres charges", note: 26, formula: ["-65"] },
    { code: "XC", label: "VALEUR AJOUTÉE", style: "subtotal", sum: ["XB", "RA", "RB", "TE", "TF", "TG", "TH", "TI", "RC", "RD", "RE", "RF", "RG", "RH", "RI", "RJ"] },
    { code: "RK", label: "Charges de personnel", note: 27, formula: ["-66"] },
    { code: "XD", label: "EXCÉDENT BRUT D'EXPLOITATION", style: "subtotal", sum: ["XC", "RK"] },
    { code: "TJ", label: "Reprises d'amortissements, provisions et dépréciations", note: 28, formula: ["-791", "-798"] },
    { code: "RL", label: "Dotations aux amortissements, aux provisions et dépréciations", note: "3C", formula: ["-681", "-691"] },
    { code: "XE", label: "RÉSULTAT D'EXPLOITATION", style: "subtotal", sum: ["XD", "TJ", "RL"] },
    { code: "TK", label: "Revenus financiers et assimilés", note: 29, formula: ["-771", "-772", "-773", "-774", "-775", "-776", "-777", "-778"] },
    { code: "TL", label: "Reprises de provisions et dépréciations financières", note: 28, formula: ["-779", "-797"] },
    { code: "TM", label: "Transferts de charges financières", note: 12, formula: ["-787"] },
    { code: "RM", label: "Frais financiers et charges assimilées", note: 29, formula: ["-671", "-672", "-673", "-674", "-675", "-676", "-677", "-678"] },
    { code: "RN", label: "Dotations aux provisions et aux dépréciations financières", note: 28, formula: ["-679", "-687", "-697"] },
    { code: "XF", label: "RÉSULTAT FINANCIER", style: "subtotal", sum: ["TK", "TL", "TM", "RM", "RN"] },
    { code: "XG", label: "RÉSULTAT DES ACTIVITÉS ORDINAIRES", style: "subtotal", sum: ["XE", "XF"] },
    { code: "TN", label: "Produits des cessions d'immobilisations", note: "3D", formula: ["-82"] },
    { code: "TO", label: "Autres produits HAO", note: 30, formula: ["-84", "-86", "-88"] },
    { code: "RO", label: "Valeurs comptables des cessions d'immobilisations", note: "3D", formula: ["-81"] },
    { code: "RP", label: "Autres charges HAO", note: 30, formula: ["-83", "-85"] },
    { code: "XH", label: "RÉSULTAT HORS ACTIVITÉS ORDINAIRES", style: "subtotal", sum: ["TN", "TO", "RO", "RP"] },
    { code: "RQ", label: "Participation des travailleurs", note: 30, formula: ["-87"] },
    { code: "RS", label: "Impôts sur le résultat", formula: ["-89"] },
    { code: "XI", label: "RÉSULTAT NET", style: "total", sum: ["XG", "XH", "RQ", "RS"] },
  ],
};
