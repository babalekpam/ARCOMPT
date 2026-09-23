import type { NoteDefinition } from "../../types.js";

/**
 * Notes annexes SYSCOHADA révisé. Trois familles :
 *  - LEDGER : calculées depuis la balance, rapprochées d'un ou plusieurs
 *    postes des états ; chaque rapprochement est un contrôle bloquant ;
 *  - MODULE : les montants ne sont pas dans le grand livre (effectifs,
 *    échéances, engagements, contrats) ; la note sort en `DRAFT_REQUIRED`
 *    et attend une saisie ou un module. Aucune dérivation n'est inventée ;
 *  - NARRATIVE : brouillon rédigé par l'IA à partir des données, à valider.
 *
 * Les montants suivent la convention du poste rapproché (actif : D − C ;
 * passif et compte de résultat : C − D).
 *
 * Exhaustivité. Une note LEDGER reprend exactement les mêmes racines de
 * comptes que le ou les postes qu'elle détaille, de sorte que l'égalité tient
 * pour n'importe quelle balance et pas seulement pour la balance de référence.
 * Quand une famille est détaillée compte par compte, la dernière ligne est un
 * solde par différence (« racine moins les lignes déjà présentées ») : un
 * sous-compte non prévu y tombe au lieu de faire échouer le rapprochement
 * en silence.
 *
 * INDICATIF. Les numéros de notes, leurs intitulés et la table de passage
 * comptes → lignes sont indicatifs et **restent à valider**, comme les taux
 * des packs pays : un expert-comptable inscrit dans le pays de dépôt doit les
 * confronter au formulaire officiel de la liasse (DSF) avant tout dépôt réel.
 * Les numéros suffixés qui ne figurent pas tels quels au référentiel (8A, 12B,
 * 14B, 16C, 36, 37) ont été ajoutés pour couvrir des informations exigées sans
 * poste dédié ; leur rattachement au formulaire officiel fait partie de cette
 * validation.
 */
export const NOTES: NoteDefinition[] = [
  {
    number: 1,
    title: "Dettes garanties par des sûretés réelles",
    kind: "MODULE",
    outline: [
      "Dettes assorties d'une sûreté réelle : créancier, montant restant dû, nature de la sûreté (hypothèque, nantissement, gage, privilège)",
      "Biens donnés en garantie : désignation et valeur comptable nette",
      "Date de prise d'effet et date d'extinction de chaque sûreté",
      "À saisir : le grand livre ne distingue pas une dette garantie d'une dette non garantie ; l'information vient des contrats de prêt et du registre des sûretés",
    ],
  },
  {
    number: 2,
    title: "Informations obligatoires – règles et méthodes comptables",
    kind: "NARRATIVE",
    outline: [
      "Référentiel : SYSCOHADA révisé, système normal ou minimal de trésorerie",
      "Méthodes d'évaluation des immobilisations et durées d'amortissement",
      "Méthodes d'évaluation des stocks",
      "Conversion des opérations en devises",
      "Changements de méthode et leurs effets",
    ],
  },
  {
    number: "3A",
    title: "Immobilisations brutes",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "AZ", column: "brut" },
    rows: [
      { label: "Immobilisations incorporelles", formula: ["+21"] },
      { label: "Terrains", formula: ["+22"] },
      { label: "Bâtiments, installations techniques et agencements", formula: ["+23"] },
      { label: "Matériel, mobilier et actifs biologiques", formula: ["+24"] },
      { label: "Avances et acomptes versés sur immobilisations", formula: ["+25"] },
      { label: "Titres de participation", formula: ["+26"] },
      { label: "Autres immobilisations financières", formula: ["+27"] },
    ],
  },
  {
    number: "3B",
    title: "Biens pris en location-acquisition",
    kind: "MODULE",
    outline: [
      "Contrats en cours : bien, date de prise d'effet, durée, valeur d'entrée, option d'achat",
      "Valeur brute, amortissements cumulés et valeur nette des biens pris en location-acquisition",
      "Redevances restant dues, ventilées entre la part de capital (compte 17) et la part d'intérêts (compte 672)",
      "À saisir : le grand livre porte la dette (17) et le bien (comptes 2x), mais aucune caractéristique de contrat ; l'information vient du module immobilisations ou des contrats",
    ],
  },
  {
    number: "3C",
    title: "Immobilisations : amortissements et dépréciations",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "AZ", column: "amort_prov" },
    rows: [
      { label: "Amortissements des immobilisations incorporelles", formula: ["+281:C", "+291:C"] },
      { label: "Amortissements des terrains", formula: ["+282:C", "+292:C"] },
      { label: "Amortissements des bâtiments, installations et agencements", formula: ["+283:C", "+293:C"] },
      { label: "Amortissements du matériel, mobilier et actifs biologiques", formula: ["+284:C", "+294:C"] },
      { label: "Dépréciations des immobilisations financières et avances", formula: ["+295:C", "+296:C", "+297:C"] },
    ],
  },
  {
    number: "3D",
    title: "Immobilisations : plus-values et moins-values de cession",
    kind: "LEDGER",
    // Total = produits de cession (TN) + valeurs comptables cédées (RO, négatif) :
    // le solde est la plus-value (positif) ou la moins-value (négatif) de l'exercice.
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "TN" },
      { statement: "COMPTE_RESULTAT", code: "RO" },
    ],
    rows: [
      { label: "Produits des cessions d'immobilisations incorporelles", formula: ["-821"] },
      { label: "Produits des cessions d'immobilisations corporelles", formula: ["-822"] },
      { label: "Produits des cessions d'immobilisations financières", formula: ["-826"] },
      { label: "Autres produits de cession", formula: ["-82", "+821", "+822", "+826"] },
      { label: "Valeurs comptables des immobilisations cédées", formula: ["-81"] },
    ],
  },
  {
    number: "3E",
    title: "Écarts de réévaluation",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_PASSIF", code: "CE" },
    rows: [
      { label: "Écarts de réévaluation légale", formula: ["-1061"] },
      { label: "Écarts de réévaluation libre", formula: ["-1062"] },
      { label: "Autres écarts de réévaluation", formula: ["-106", "+1061", "+1062"] },
    ],
  },
  {
    number: 4,
    title: "Immobilisations financières",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "AQ", column: "brut" },
    rows: [
      { label: "Titres de participation dans des sociétés sous contrôle exclusif ou conjoint", formula: ["+261", "+262"] },
      { label: "Titres de participation conférant une influence notable", formula: ["+263"] },
      { label: "Autres titres de participation", formula: ["+26", "-261", "-262", "-263"] },
      { label: "Prêts et créances non commerciales, prêts au personnel", formula: ["+271", "+272"] },
      { label: "Créances sur l'État et titres immobilisés", formula: ["+273", "+274"] },
      { label: "Dépôts et cautionnements versés", formula: ["+275"] },
      { label: "Autres immobilisations financières et intérêts courus", formula: ["+27", "-271", "-272", "-273", "-274", "-275"] },
    ],
  },
  {
    number: 5,
    title: "Actif circulant hors activités ordinaires",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BA", column: "brut" },
    rows: [
      { label: "Créances sur cessions d'immobilisations", formula: ["+485:D"] },
      { label: "Créances sur cessions de titres de placement", formula: ["+486:D"] },
      { label: "Autres créances hors activités ordinaires", formula: ["+488:D"] },
      { label: "Autres comptes HAO à solde débiteur", formula: ["+48:D", "-485:D", "-486:D", "-488:D"] },
    ],
  },
  {
    number: 6,
    title: "Stocks et encours",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BB", column: "brut" },
    rows: [
      { label: "Marchandises", formula: ["+31"] },
      { label: "Matières premières et fournitures liées", formula: ["+32"] },
      { label: "Autres approvisionnements", formula: ["+33"] },
      { label: "Produits et services en cours", formula: ["+34", "+35"] },
      { label: "Produits finis, intermédiaires et résiduels", formula: ["+36", "+37"] },
      { label: "Stocks en cours de route, en consignation ou en dépôt", formula: ["+38"] },
    ],
  },
  {
    number: 7,
    title: "Clients",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BI", column: "brut" },
    rows: [
      { label: "Clients", formula: ["+411:D"] },
      { label: "Clients, effets à recevoir en portefeuille", formula: ["+412:D", "+415:D"] },
      { label: "Clients, créances litigieuses ou douteuses", formula: ["+414:D", "+416:D"] },
      { label: "Clients, produits à recevoir", formula: ["+418:D"] },
      { label: "Clients créditeurs à solde débiteur", formula: ["+419:D"] },
      { label: "Autres comptes clients à solde débiteur", formula: ["+41:D", "-411:D", "-412:D", "-414:D", "-415:D", "-416:D", "-418:D", "-419:D"] },
    ],
  },
  {
    number: 8,
    title: "Autres créances",
    kind: "LEDGER",
    reconciles: [
      { statement: "BILAN_ACTIF", code: "BH", column: "brut" },
      { statement: "BILAN_ACTIF", code: "BJ", column: "brut" },
    ],
    rows: [
      { label: "Fournisseurs, avances et acomptes versés", formula: ["+40:D"] },
      { label: "Personnel", formula: ["+42:D"] },
      { label: "Organismes sociaux", formula: ["+43:D"] },
      { label: "État et collectivités publiques", formula: ["+44:D"] },
      { label: "Organismes internationaux", formula: ["+45:D"] },
      { label: "Associés et groupe", formula: ["+461:D", "+462:D", "+463:D", "+465:D", "+466:D", "+467:D"] },
      { label: "Débiteurs divers et comptes de régularisation", formula: ["+471:D", "+472:D", "+474:D", "+475:D", "+476:D", "+477:D"] },
    ],
  },
  {
    number: "8A",
    title: "Dépréciations de l'actif circulant et de la trésorerie",
    kind: "LEDGER",
    // Colonne « amortissements et dépréciations » de tous les postes de l'actif
    // circulant et de la trésorerie : les dépréciations des immobilisations
    // sont en note 3C, celles des stocks et des tiers ici.
    reconciles: [
      { statement: "BILAN_ACTIF", code: "BA", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BB", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BH", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BI", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BJ", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BQ", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BR", column: "amort_prov" },
      { statement: "BILAN_ACTIF", code: "BS", column: "amort_prov" },
    ],
    rows: [
      { label: "Dépréciations des stocks et encours", formula: ["+39:C"] },
      { label: "Dépréciations des comptes fournisseurs", formula: ["+490:C"] },
      { label: "Dépréciations des comptes clients", formula: ["+491:C"] },
      { label: "Dépréciations des autres créances", formula: ["+492:C", "+493:C", "+494:C", "+495:C", "+496:C", "+497:C"] },
      { label: "Dépréciations des créances hors activités ordinaires", formula: ["+498:C"] },
      { label: "Dépréciations des titres de placement", formula: ["+590:C"] },
      { label: "Dépréciations des valeurs à encaisser", formula: ["+591:C"] },
      { label: "Dépréciations des comptes de trésorerie", formula: ["+592:C", "+593:C", "+594:C"] },
    ],
  },
  {
    number: 9,
    title: "Titres de placement",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BQ", column: "brut" },
    rows: [
      { label: "Titres du Trésor et bons de caisse à court terme", formula: ["+501"] },
      { label: "Actions et obligations", formula: ["+502", "+503"] },
      { label: "Bons de souscription et titres négociables hors région", formula: ["+504", "+505"] },
      { label: "Intérêts courus et autres valeurs assimilées", formula: ["+50", "-501", "-502", "-503", "-504", "-505"] },
    ],
  },
  {
    number: 10,
    title: "Valeurs à encaisser",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BR", column: "brut" },
    rows: [
      { label: "Effets à encaisser et à l'encaissement", formula: ["+511", "+512"] },
      { label: "Chèques à encaisser et à l'encaissement", formula: ["+513", "+514"] },
      { label: "Cartes de crédit à encaisser", formula: ["+515"] },
      { label: "Autres valeurs à l'encaissement", formula: ["+51", "-511", "-512", "-513", "-514", "-515"] },
    ],
  },
  {
    number: 11,
    title: "Disponibilités",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BS", column: "brut" },
    rows: [
      { label: "Banques", formula: ["+52:D"] },
      { label: "Établissements financiers, mobile money et assimilés", formula: ["+53:D"] },
      { label: "Instruments de trésorerie", formula: ["+54:D"] },
      { label: "Caisse", formula: ["+57:D"] },
      { label: "Régies d'avances, accréditifs et virements internes", formula: ["+58:D"] },
    ],
  },
  {
    number: 12,
    title: "Écarts de conversion",
    kind: "LEDGER",
    reconciles: [
      { statement: "BILAN_ACTIF", code: "BU", column: "brut" },
      { statement: "BILAN_PASSIF", code: "DV" },
    ],
    rows: [
      { label: "Écart de conversion – Actif (perte latente)", formula: ["+478:D"] },
      { label: "Écart de conversion – Passif (gain latent)", formula: ["+479:C"] },
    ],
  },
  {
    number: "12B",
    title: "Transferts de charges",
    kind: "LEDGER",
    // Les transferts de charges portent le même renvoi de note que les écarts
    // de conversion dans certains formulaires ; ils sont présentés à part pour
    // que le total de chaque note reste une somme homogène. Rattachement au
    // formulaire officiel à valider.
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "TI" },
      { statement: "COMPTE_RESULTAT", code: "TM" },
    ],
    rows: [
      { label: "Transferts de charges d'exploitation", formula: ["-781"] },
      { label: "Transferts de charges financières", formula: ["-787"] },
    ],
  },
  {
    number: 13,
    title: "Capital",
    kind: "LEDGER",
    reconciles: [
      { statement: "BILAN_PASSIF", code: "CA" },
      { statement: "BILAN_PASSIF", code: "CB" },
    ],
    rows: [
      { label: "Capital social", formula: ["-101"] },
      { label: "Capital par dotation", formula: ["-102"] },
      { label: "Capital personnel", formula: ["-103"] },
      { label: "Compte de l'exploitant", formula: ["-104"] },
      { label: "Apporteurs, capital souscrit non appelé (−)", formula: ["-109"] },
    ],
  },
  {
    number: 14,
    title: "Primes, réserves et report à nouveau",
    kind: "LEDGER",
    reconciles: [
      { statement: "BILAN_PASSIF", code: "CD" },
      { statement: "BILAN_PASSIF", code: "CF" },
      { statement: "BILAN_PASSIF", code: "CG" },
      { statement: "BILAN_PASSIF", code: "CH" },
    ],
    rows: [
      { label: "Primes liées au capital social", formula: ["-105"] },
      { label: "Réserve légale", formula: ["-111"] },
      { label: "Réserves statutaires, contractuelles et réglementées", formula: ["-112", "-113"] },
      { label: "Réserves libres", formula: ["-118"] },
      { label: "Report à nouveau (+ ou −)", formula: ["-12"] },
    ],
  },
  {
    number: "14B",
    title: "Variation des capitaux propres de l'exercice",
    kind: "MODULE",
    outline: [
      "Solde d'ouverture de chaque poste de capitaux propres : la colonne N-1 des notes 13, 14, 15 et 3E le donne",
      "Augmentations de capital : apports nouveaux en numéraire ou en nature, incorporation de réserves, conversion de dettes",
      "Affectation du résultat de l'exercice précédent : dotation aux réserves, report à nouveau, dividendes distribués",
      "Réductions de capital, prélèvements de l'exploitant, écarts de réévaluation de l'exercice",
      "À saisir : le grand livre donne les soldes d'ouverture et de clôture, pas la nature de chaque mouvement ; la décision d'affectation (procès-verbal d'assemblée) est requise",
    ],
  },
  {
    number: 15,
    title: "Subventions d'investissement et provisions réglementées",
    kind: "LEDGER",
    reconciles: [
      { statement: "BILAN_PASSIF", code: "CL" },
      { statement: "BILAN_PASSIF", code: "CM" },
    ],
    rows: [
      { label: "Subventions d'équipement", formula: ["-141"] },
      { label: "Autres subventions d'investissement", formula: ["-14", "+141"] },
      { label: "Amortissements dérogatoires", formula: ["-151"] },
      { label: "Plus-values de cession à réinvestir et fonds réglementés", formula: ["-152", "-153"] },
      { label: "Autres provisions réglementées et fonds assimilés", formula: ["-15", "+151", "+152", "+153"] },
    ],
  },
  {
    number: "16A",
    title: "Dettes financières et ressources assimilées",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_PASSIF", code: "DD" },
    rows: [
      { label: "Emprunts obligataires", formula: ["-161"] },
      { label: "Emprunts et dettes auprès des établissements de crédit", formula: ["-162"] },
      { label: "Avances, dépôts et cautionnements reçus, autres emprunts", formula: ["-16", "+161", "+162"] },
      { label: "Dettes de location-acquisition", formula: ["-17"] },
      { label: "Dettes liées à des participations et comptes de liaison", formula: ["-18"] },
      { label: "Provisions pour risques et charges", formula: ["-19"] },
    ],
  },
  {
    number: "16B",
    title: "Engagements de retraite et avantages assimilés",
    kind: "MODULE",
    outline: [
      "Méthode retenue : provision au bilan (compte 196) ou engagement mentionné hors bilan",
      "Hypothèses actuarielles : taux d'actualisation, table de mortalité, taux de rotation, progression des salaires, âge de départ",
      "Engagement à la clôture, charge de l'exercice, prestations versées",
      "À saisir : aucune évaluation actuarielle ne se déduit de la balance ; elle vient du module paie ou d'un actuaire",
    ],
  },
  {
    number: "16C",
    title: "Échéancier des créances et des dettes",
    kind: "MODULE",
    outline: [
      "Créances : à un an au plus, à plus d'un an — ventilation des notes 7, 8 et 4",
      "Dettes financières : à un an au plus, de un à cinq ans, à plus de cinq ans — ventilation de la note 16A",
      "Dettes d'exploitation et autres dettes : à un an au plus, à plus d'un an — ventilation des notes 17, 18 et 19",
      "Créances et dettes échues et non réglées à la clôture",
      "À saisir : aucun compte ne distingue l'échéance ; elle vient de la balance âgée des tiers et des tableaux d'amortissement d'emprunt, jamais d'une répartition forfaitaire",
    ],
  },
  {
    number: 17,
    title: "Fournisseurs d'exploitation",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_PASSIF", code: "DJ" },
    rows: [
      { label: "Fournisseurs, dettes en compte", formula: ["+401:C"] },
      { label: "Fournisseurs, effets à payer", formula: ["+402:C"] },
      { label: "Fournisseurs, factures non parvenues", formula: ["+408:C"] },
      { label: "Fournisseurs débiteurs à solde créditeur", formula: ["+409:C"] },
      { label: "Autres comptes fournisseurs à solde créditeur", formula: ["+40:C", "-401:C", "-402:C", "-408:C", "-409:C"] },
    ],
  },
  {
    number: 18,
    title: "Dettes fiscales et sociales",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_PASSIF", code: "DK" },
    rows: [
      { label: "Personnel", formula: ["+42:C"] },
      { label: "Organismes sociaux", formula: ["+43:C"] },
      { label: "État, impôt sur les bénéfices", formula: ["+441:C"] },
      { label: "État, TVA", formula: ["+443:C", "+444:C", "+445:C", "+446:C"] },
      { label: "État, autres impôts, taxes et retenues", formula: ["+44:C", "-441:C", "-443:C", "-444:C", "-445:C", "-446:C"] },
    ],
  },
  {
    number: 19,
    title: "Autres dettes et provisions pour risques à court terme",
    kind: "LEDGER",
    reconciles: [
      { statement: "BILAN_PASSIF", code: "DH" },
      { statement: "BILAN_PASSIF", code: "DI" },
      { statement: "BILAN_PASSIF", code: "DM" },
      { statement: "BILAN_PASSIF", code: "DN" },
    ],
    rows: [
      { label: "Dettes circulantes hors activités ordinaires", formula: ["+48:C"] },
      { label: "Clients, avances et acomptes reçus", formula: ["+41:C"] },
      { label: "Organismes internationaux", formula: ["+45:C"] },
      { label: "Associés et groupe", formula: ["+461:C", "+462:C", "+463:C", "+465:C", "+466:C", "+467:C"] },
      { label: "Créditeurs divers et comptes de régularisation", formula: ["+471:C", "+472:C", "+474:C", "+475:C", "+476:C", "+477:C"] },
      { label: "Provisions pour risques à court terme", formula: ["-499", "-599"] },
    ],
  },
  {
    number: 20,
    title: "Banques, crédits d'escompte et de trésorerie",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_PASSIF", code: "DT" },
    rows: [
      { label: "Escompte de crédits de campagne et de crédits ordinaires", formula: ["-564", "-565"] },
      { label: "Crédits de trésorerie et intérêts courus", formula: ["-561", "-566"] },
      { label: "Banques et établissements financiers, soldes créditeurs", formula: ["+52:C", "+53:C", "+54:C", "+58:C"] },
      { label: "Caisse, solde créditeur", formula: ["+57:C"] },
    ],
  },
  {
    number: 21,
    title: "Chiffre d'affaires et autres produits",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "XB" },
      { statement: "COMPTE_RESULTAT", code: "TG" },
      { statement: "COMPTE_RESULTAT", code: "TH" },
    ],
    rows: [
      { label: "Ventes de marchandises", formula: ["-701"] },
      { label: "Ventes de produits fabriqués", formula: ["-702", "-703", "-704"] },
      { label: "Travaux, services vendus", formula: ["-705", "-706"] },
      { label: "Produits accessoires", formula: ["-707"] },
      { label: "Subventions d'exploitation", formula: ["-71"] },
      { label: "Autres produits", formula: ["-75"] },
    ],
  },
  {
    number: 22,
    title: "Achats et variations de stocks",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "RA" },
      { statement: "COMPTE_RESULTAT", code: "RB" },
      { statement: "COMPTE_RESULTAT", code: "RC" },
      { statement: "COMPTE_RESULTAT", code: "RD" },
      { statement: "COMPTE_RESULTAT", code: "RE" },
      { statement: "COMPTE_RESULTAT", code: "RF" },
    ],
    rows: [
      { label: "Achats de marchandises", formula: ["-601"] },
      { label: "Variation des stocks de marchandises", formula: ["-6031"] },
      { label: "Achats de matières premières et fournitures liées", formula: ["-602"] },
      { label: "Variation des stocks de matières premières et fournitures liées", formula: ["-6032"] },
      { label: "Achats stockés de matières et fournitures consommables", formula: ["-604"] },
      { label: "Autres achats (eau, électricité, petit matériel, études)", formula: ["-605"] },
      { label: "Achats d'emballages", formula: ["-608"] },
      { label: "Variation des stocks d'autres approvisionnements", formula: ["-6033"] },
    ],
  },
  {
    number: 23,
    title: "Transports",
    kind: "LEDGER",
    reconciles: { statement: "COMPTE_RESULTAT", code: "RG" },
    rows: [
      { label: "Transports sur achats", formula: ["-611"] },
      { label: "Transports sur ventes", formula: ["-612"] },
      { label: "Transports pour le compte de tiers", formula: ["-613"] },
      { label: "Transports du personnel", formula: ["-614"] },
      { label: "Transports de plis et autres frais de transport", formula: ["-61", "+611", "+612", "+613", "+614"] },
    ],
  },
  {
    number: 24,
    title: "Services extérieurs",
    kind: "LEDGER",
    reconciles: { statement: "COMPTE_RESULTAT", code: "RH" },
    rows: [
      { label: "Sous-traitance générale", formula: ["-621"] },
      { label: "Locations et charges locatives", formula: ["-622", "-623"] },
      { label: "Entretien, réparations et maintenance", formula: ["-624"] },
      { label: "Primes d'assurance", formula: ["-625"] },
      { label: "Études, publicité, télécommunications", formula: ["-626", "-627", "-628"] },
      { label: "Frais bancaires", formula: ["-631"] },
      { label: "Honoraires, formation, redevances, cotisations", formula: ["-632", "-633", "-634", "-635"] },
      { label: "Personnel extérieur", formula: ["-637"] },
      {
        label: "Autres services extérieurs",
        formula: ["-62", "-63", "+621", "+622", "+623", "+624", "+625", "+626", "+627", "+628", "+631", "+632", "+633", "+634", "+635", "+637"],
      },
    ],
  },
  {
    number: 25,
    title: "Impôts et taxes et impôts sur le résultat",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "RI" },
      { statement: "COMPTE_RESULTAT", code: "RS" },
    ],
    rows: [
      { label: "Impôts et taxes directs", formula: ["-641"] },
      { label: "Impôts et taxes indirects", formula: ["-645"] },
      { label: "Droits d'enregistrement", formula: ["-646"] },
      { label: "Pénalités et amendes fiscales", formula: ["-647"] },
      { label: "Autres impôts et taxes", formula: ["-64", "+641", "+645", "+646", "+647"] },
      { label: "Impôts sur le résultat (exercice, rappels, impôt minimum forfaitaire)", formula: ["-89"] },
    ],
  },
  {
    number: 26,
    title: "Autres charges",
    kind: "LEDGER",
    reconciles: { statement: "COMPTE_RESULTAT", code: "RJ" },
    rows: [
      { label: "Pertes sur créances clients et autres débiteurs", formula: ["-651"] },
      { label: "Quotes-parts de résultat sur opérations faites en commun", formula: ["-652", "-653"] },
      { label: "Valeurs comptables des cessions courantes d'immobilisations", formula: ["-654"] },
      { label: "Charges provisionnées d'exploitation", formula: ["-659"] },
      { label: "Charges diverses", formula: ["-65", "+651", "+652", "+653", "+654", "+659"] },
    ],
  },
  {
    number: "27A",
    title: "Charges de personnel",
    kind: "LEDGER",
    reconciles: { statement: "COMPTE_RESULTAT", code: "RK" },
    rows: [
      { label: "Rémunérations directes versées au personnel national", formula: ["-661"] },
      { label: "Rémunérations directes versées au personnel non national", formula: ["-662"] },
      { label: "Indemnités forfaitaires versées au personnel", formula: ["-663"] },
      { label: "Charges sociales", formula: ["-664"] },
      { label: "Rémunération et charges sociales de l'exploitant individuel", formula: ["-666"] },
      { label: "Rémunération transférée de personnel extérieur", formula: ["-667"] },
      { label: "Autres charges de personnel", formula: ["-66", "+661", "+662", "+663", "+664", "+666", "+667"] },
    ],
  },
  {
    number: "27B",
    title: "Effectifs, masse salariale et personnel extérieur",
    kind: "MODULE",
    outline: [
      "Effectif moyen de l'exercice par catégorie (cadres, agents de maîtrise, employés, ouvriers) et par sexe",
      "Répartition entre personnel national et non national",
      "Masse salariale par catégorie et charges sociales correspondantes",
      "Personnel extérieur à l'entreprise : effectif et coût (comptes 637 et 667)",
      "À saisir : la balance donne les montants (note 27A) mais aucun effectif ; les nombres viennent du module paie ou du registre du personnel",
    ],
  },
  {
    number: 28,
    title: "Dotations et reprises d'amortissements, de provisions et de dépréciations",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "TJ" },
      { statement: "COMPTE_RESULTAT", code: "TL" },
      { statement: "COMPTE_RESULTAT", code: "RL" },
      { statement: "COMPTE_RESULTAT", code: "RN" },
    ],
    rows: [
      { label: "Reprises d'amortissements, de provisions et de dépréciations d'exploitation", formula: ["-791", "-798"] },
      { label: "Reprises de provisions et de dépréciations financières", formula: ["-779", "-797"] },
      { label: "Dotations aux amortissements, aux provisions et aux dépréciations d'exploitation", formula: ["-681", "-691"] },
      { label: "Dotations aux amortissements, aux provisions et aux dépréciations financières", formula: ["-679", "-687", "-697"] },
    ],
  },
  {
    number: 29,
    title: "Charges et revenus financiers",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "TK" },
      { statement: "COMPTE_RESULTAT", code: "RM" },
    ],
    rows: [
      { label: "Intérêts de prêts et revenus de participations", formula: ["-771", "-772"] },
      { label: "Escomptes obtenus et revenus de titres", formula: ["-773", "-774", "-775"] },
      { label: "Gains de change et autres revenus financiers", formula: ["-776", "-777", "-778"] },
      { label: "Intérêts des emprunts et des dettes de location-acquisition", formula: ["-671", "-672"] },
      { label: "Escomptes accordés et autres intérêts", formula: ["-673", "-674", "-675"] },
      { label: "Pertes de change et autres charges financières", formula: ["-676", "-677", "-678"] },
    ],
  },
  {
    number: 30,
    title: "Autres charges et produits hors activités ordinaires",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "TO" },
      { statement: "COMPTE_RESULTAT", code: "RP" },
      { statement: "COMPTE_RESULTAT", code: "RQ" },
    ],
    rows: [
      { label: "Produits hors activités ordinaires", formula: ["-84"] },
      { label: "Reprises hors activités ordinaires", formula: ["-86"] },
      { label: "Subventions d'équilibre", formula: ["-88"] },
      { label: "Charges hors activités ordinaires", formula: ["-83"] },
      { label: "Dotations hors activités ordinaires", formula: ["-85"] },
      { label: "Participation des travailleurs", formula: ["-87"] },
    ],
  },
  {
    number: 31,
    title: "Répartition du résultat et éléments caractéristiques des cinq derniers exercices",
    kind: "MODULE",
    outline: [
      "Résultat de l'exercice et proposition d'affectation : réserve légale, autres réserves, report à nouveau, dividendes",
      "Dividende par action ou par part sociale",
      "Cinq derniers exercices : capital, chiffre d'affaires, résultat net, effectif, capitaux propres",
      "À saisir : le moteur ne dispose que des exercices N et N-1 ; les trois exercices antérieurs et la décision d'affectation doivent être repris des liasses déposées",
    ],
  },
  {
    number: 32,
    title: "Production de l'exercice",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "TB" },
      { statement: "COMPTE_RESULTAT", code: "TC" },
      { statement: "COMPTE_RESULTAT", code: "TD" },
      { statement: "COMPTE_RESULTAT", code: "TE" },
      { statement: "COMPTE_RESULTAT", code: "TF" },
    ],
    rows: [
      { label: "Production vendue : produits fabriqués", formula: ["-702", "-703", "-704"] },
      { label: "Production vendue : travaux et services", formula: ["-705", "-706"] },
      { label: "Production vendue : produits accessoires", formula: ["-707"] },
      { label: "Production stockée (ou déstockage)", formula: ["-73"] },
      { label: "Production immobilisée", formula: ["-72"] },
    ],
  },
  {
    number: 33,
    title: "Achats destinés à la production",
    kind: "LEDGER",
    reconciles: [
      { statement: "COMPTE_RESULTAT", code: "RC" },
      { statement: "COMPTE_RESULTAT", code: "RD" },
      { statement: "COMPTE_RESULTAT", code: "RE" },
      { statement: "COMPTE_RESULTAT", code: "RF" },
    ],
    rows: [
      { label: "Achats de matières premières et fournitures liées", formula: ["-602"] },
      { label: "Variation des stocks de matières premières et fournitures liées", formula: ["-6032"] },
      { label: "Achats stockés de matières et fournitures consommables", formula: ["-604"] },
      { label: "Autres achats consommés", formula: ["-605", "-608"] },
      { label: "Variation des stocks d'autres approvisionnements", formula: ["-6033"] },
    ],
  },
  {
    number: 34,
    title: "Fiche de synthèse des principaux indicateurs financiers",
    kind: "NARRATIVE",
    outline: [
      "Indicateurs d'activité : chiffre d'affaires (XB), valeur ajoutée (XC), excédent brut d'exploitation (XD)",
      "Indicateurs de rentabilité : résultat d'exploitation (XE), résultat net (XI), capacité d'autofinancement globale (FA du TFT)",
      "Indicateurs de structure : capitaux propres (CP), ressources stables (DF), fonds de roulement, besoin en fonds de roulement, trésorerie nette (ZH)",
      "Ratios et taux de variation : les postes sont calculés par le moteur, mais les ratios eux-mêmes sortent du modèle « une ligne, un montant » et sont à établir et à commenter",
    ],
  },
  {
    number: 35,
    title: "Événements postérieurs à la clôture",
    kind: "NARRATIVE",
    outline: ["Événements survenus entre la clôture et l'arrêté des comptes", "Incidence sur les états financiers", "Continuité d'exploitation"],
  },
  {
    number: 36,
    title: "Engagements donnés et reçus (hors bilan)",
    kind: "MODULE",
    outline: [
      "Engagements de financement obtenus et accordés (comptes 901 et 905)",
      "Engagements de garantie obtenus et accordés : cautions, avals, hypothèques consenties (comptes 902 et 906)",
      "Effets escomptés non échus, engagements de location simple, commandes fermes d'immobilisations",
      "Engagements de retraite non provisionnés : renvoi à la note 16B",
      "À saisir : les engagements ne sont enregistrés que si le dossier tient les comptes de classe 9, que le moteur ne reprend dans aucun état ; un engagement absent de la balance est indiscernable d'un engagement inexistant, il faut donc le confirmer et non le déduire",
    ],
  },
  {
    number: 37,
    title: "Transactions avec les parties liées",
    kind: "MODULE",
    outline: [
      "Identification des parties liées : société mère, filiales, entités sous contrôle commun, dirigeants et leurs proches",
      "Soldes à la clôture : comptes 26, 27, 18, 46 (associés et groupe) — à ventiler par partie liée",
      "Transactions de l'exercice : ventes, achats, prêts, garanties, rémunérations des dirigeants",
      "Conditions des opérations : prix, échéances, sûretés, et mention des conditions autres que celles du marché",
      "À saisir : le plan de comptes identifie des comptes de groupe mais pas les parties liées elles-mêmes ni les conditions des opérations",
    ],
  },
];
