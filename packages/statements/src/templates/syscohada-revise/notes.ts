import type { NoteDefinition } from "../../types.js";

/**
 * Notes annexes SYSCOHADA révisé (extrait). Trois familles :
 *  - LEDGER : calculées depuis la balance, rapprochées d'un poste de l'état ;
 *  - MODULE : alimentées par un module (immobilisations, paie) ;
 *  - NARRATIVE : brouillon rédigé par l'IA à partir des données, à valider.
 *
 * Les montants suivent la convention du poste rapproché (actif : D − C ;
 * passif et compte de résultat : C − D).
 */
export const NOTES: NoteDefinition[] = [
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
    ],
  },
  {
    number: 8,
    title: "Autres créances",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_ACTIF", code: "BJ", column: "brut" },
    rows: [
      { label: "Personnel", formula: ["+42:D"] },
      { label: "Organismes sociaux", formula: ["+43:D"] },
      { label: "État et collectivités publiques", formula: ["+44:D"] },
      { label: "Organismes internationaux", formula: ["+45:D"] },
      { label: "Associés et groupe", formula: ["+461:D", "+462:D", "+463:D", "+465:D", "+466:D", "+467:D"] },
      { label: "Débiteurs divers et comptes de régularisation", formula: ["+471:D", "+472:D", "+474:D", "+475:D", "+476:D", "+477:D"] },
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
    number: 13,
    title: "Capital",
    kind: "LEDGER",
    reconciles: { statement: "BILAN_PASSIF", code: "CA" },
    rows: [
      { label: "Capital social", formula: ["-101"] },
      { label: "Capital par dotation", formula: ["-102"] },
      { label: "Capital personnel", formula: ["-103"] },
      { label: "Compte de l'exploitant", formula: ["-104"] },
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
      { label: "Avances, dépôts et cautionnements reçus, autres emprunts", formula: ["-163", "-164", "-165", "-166", "-167", "-168"] },
      { label: "Dettes de location-acquisition", formula: ["-17"] },
      { label: "Dettes liées à des participations et comptes de liaison", formula: ["-18"] },
      { label: "Provisions pour risques et charges", formula: ["-19"] },
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
      { label: "État, autres impôts, taxes et retenues", formula: ["+442:C", "+447:C", "+448:C", "+449:C"] },
    ],
  },
  {
    number: 21,
    title: "Chiffre d'affaires et autres produits",
    kind: "LEDGER",
    reconciles: { statement: "COMPTE_RESULTAT", code: "XB" },
    rows: [
      { label: "Ventes de marchandises", formula: ["-701"] },
      { label: "Ventes de produits fabriqués", formula: ["-702", "-703", "-704"] },
      { label: "Travaux, services vendus", formula: ["-705", "-706"] },
      { label: "Produits accessoires", formula: ["-707"] },
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
      { label: "Personnel extérieur et autres charges externes", formula: ["-637", "-638"] },
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
      { label: "Autres charges de personnel", formula: ["-667", "-668"] },
    ],
  },
  {
    number: "27B",
    title: "Effectifs, masse salariale et personnel extérieur",
    kind: "MODULE",
    outline: ["Effectif moyen par catégorie et par sexe (module paie)", "Masse salariale par catégorie", "Personnel extérieur"],
  },
  {
    number: 35,
    title: "Événements postérieurs à la clôture",
    kind: "NARRATIVE",
    outline: ["Événements survenus entre la clôture et l'arrêté des comptes", "Incidence sur les états financiers", "Continuité d'exploitation"],
  },
];
