/**
 * Traductions d'appoint des intitulés SYSCOHADA révisé.
 *
 * ── Pourquoi ce fichier n'est pas un dictionnaire ordinaire ──────────────
 *
 * Les intitulés de postes du bilan, du compte de résultat et du TFT sont du
 * texte RÉGLEMENTAIRE. « TOTAL ACTIF IMMOBILISÉ » en face du code AZ n'est pas
 * une étiquette d'écran : c'est la formule qu'attendent l'administration
 * fiscale, la centrale des bilans et le commissaire aux comptes des dix-sept
 * États de l'espace OHADA. La remplacer par « TOTAL NON-CURRENT ASSETS »
 * produirait un état qui n'est plus le formulaire officiel.
 *
 * Les libellés français ne sont donc JAMAIS remplacés. En anglais, ils sont
 * conservés tels quels et l'anglais est ajouté À CÔTÉ, en glose : le lecteur
 * anglophone comprend la ligne, le contrôleur retrouve le formulaire.
 *
 * ── Registre de langue ──────────────────────────────────────────────────
 *
 * L'anglais retenu est celui des normes IFRS (orthographe britannique :
 * « amortisation », « capitalised »), qui est l'anglais comptable de
 * référence dans les pays anglophones voisins et celui qu'un réviseur formé
 * au Nigeria, au Ghana ou au Cameroun anglophone lit tous les jours.
 *
 * Les abréviations propres au référentiel qui n'ont pas d'équivalent anglais
 * — HAO (hors activités ordinaires), CAFG (capacité d'autofinancement
 * globale) — sont conservées entre parenthèses dans la glose.
 */

/** Glose anglaise par code de poste (la « Réf. » du formulaire officiel). */
const STATEMENT_LINES: Record<string, string> = {
  // Bilan – Actif
  AD: "Intangible assets",
  AE: "Development and prospecting costs",
  AF: "Patents, licences, software and similar rights",
  AG: "Goodwill and leasehold rights",
  AH: "Other intangible assets",
  AI: "Property, plant and equipment",
  AJ: "Land (including investment property, net)",
  AK: "Buildings",
  AL: "Fixtures, fittings and installations",
  AM: "Plant, furniture and biological assets",
  AN: "Vehicles",
  AP: "Advances and down payments on fixed assets",
  AQ: "Non-current financial assets",
  AR: "Equity investments",
  AS: "Other non-current financial assets",
  AZ: "Total non-current assets",
  BA: "Non-ordinary current assets (HAO)",
  BB: "Inventories and work in progress",
  BG: "Receivables and similar assets",
  BH: "Suppliers, advances paid",
  BI: "Trade receivables",
  BJ: "Other receivables",
  BK: "Total current assets",
  BQ: "Short-term investments",
  BR: "Items for collection",
  BS: "Banks, postal cheque accounts, cash in hand and similar",
  BT: "Total cash assets",
  BU: "Translation difference – assets",
  BZ: "Grand total",
  // Bilan – Passif
  CA: "Share capital",
  CB: "Shareholders, uncalled capital (−)",
  CD: "Share premiums",
  CE: "Revaluation surplus",
  CF: "Restricted reserves",
  CG: "Free reserves",
  CH: "Retained earnings (+ or −)",
  CJ: "Net result for the year (profit + or loss −)",
  CL: "Investment grants",
  CM: "Regulated provisions",
  CP: "Total equity and similar resources",
  DA: "Borrowings and other financial liabilities",
  DB: "Lease liabilities",
  DC: "Provisions for liabilities and charges",
  DD: "Total financial liabilities and similar resources",
  DF: "Total long-term resources",
  DH: "Non-ordinary current liabilities (HAO)",
  DI: "Customers, advances received",
  DJ: "Trade payables",
  DK: "Tax and social security liabilities",
  DM: "Other payables",
  DN: "Short-term provisions for liabilities",
  DP: "Total current liabilities",
  DQ: "Banks, discount facilities",
  DR: "Banks, financial institutions and short-term credit facilities",
  DT: "Total cash liabilities",
  DV: "Translation difference – liabilities",
  DZ: "Grand total",
  // Compte de résultat
  TA: "Sales of goods for resale",
  RA: "Purchases of goods for resale",
  RB: "Change in inventories of goods for resale",
  XA: "Gross trading margin",
  TB: "Sales of manufactured goods",
  TC: "Works and services sold",
  TD: "Ancillary income",
  XB: "Revenue",
  TE: "Change in inventories of finished goods and work in progress",
  TF: "Own work capitalised",
  TG: "Operating grants",
  TH: "Other income",
  TI: "Operating expenses transferred",
  RC: "Purchases of raw materials and related supplies",
  RD: "Change in inventories of raw materials and related supplies",
  RE: "Other purchases",
  RF: "Change in inventories of other supplies",
  RG: "Transport",
  RH: "External services",
  RI: "Taxes and duties other than income tax",
  RJ: "Other expenses",
  XC: "Value added",
  RK: "Staff costs",
  XD: "Gross operating surplus",
  TJ: "Reversals of depreciation, provisions and impairment",
  RL: "Depreciation, amortisation, provisions and impairment charges",
  XE: "Operating profit or loss",
  TK: "Financial income and similar",
  TL: "Reversals of financial provisions and impairment",
  TM: "Financial expenses transferred",
  RM: "Finance costs and similar charges",
  RN: "Financial provisions and impairment charges",
  XF: "Net financial result",
  XG: "Profit or loss from ordinary activities",
  TN: "Proceeds from disposal of fixed assets",
  TO: "Other non-ordinary income (HAO)",
  RO: "Carrying amount of fixed assets disposed of",
  RP: "Other non-ordinary expenses (HAO)",
  XH: "Profit or loss from non-ordinary activities (HAO)",
  RQ: "Employee profit-sharing",
  RS: "Income tax expense",
  XI: "Net profit or loss",
  // Tableau des flux de trésorerie
  ZA: "Net cash at 1 January (prior-year cash assets − prior-year cash liabilities)",
  FA: "Overall self-financing capacity (CAFG)",
  FB: "Change in non-ordinary current assets (HAO)",
  FC: "Change in inventories",
  FD: "Change in receivables and similar assets",
  FE: "Change in current liabilities",
  ZB: "Cash flows from operating activities",
  FF: "Payments to acquire intangible assets",
  FG: "Payments to acquire property, plant and equipment",
  FH: "Payments to acquire non-current financial assets",
  FI: "Proceeds from disposal of intangible assets and of property, plant and equipment",
  FJ: "Proceeds from disposal of non-current financial assets",
  ZC: "Cash flows from investing activities",
  FK: "Capital increases from new contributions, net of withdrawals",
  FL: "Investment grants received",
  FN: "Dividends paid",
  ZD: "Cash flows from equity",
  FO: "Borrowings raised",
  FP: "Other financial liabilities",
  FQ: "Repayment of borrowings and other financial liabilities",
  ZE: "Cash flows from borrowed capital",
  ZF: "Cash flows from financing activities",
  ZG: "Net change in cash for the period",
  ZH: "Net cash at 31 December (current-year cash assets − current-year cash liabilities)",
};

/**
 * Glose anglaise par numéro de note annexe (les numéros sont ceux du
 * référentiel et ne changent pas d'une langue à l'autre).
 */
const NOTE_TITLES: Record<string, string> = {
  "1": "Debts secured by collateral",
  "2": "Mandatory disclosures – accounting policies",
  "3A": "Fixed assets at cost",
  "3B": "Assets held under finance leases",
  "3C": "Fixed assets: depreciation and impairment",
  "3D": "Fixed assets: gains and losses on disposal",
  "3E": "Revaluation surplus",
  "4": "Non-current financial assets",
  "5": "Non-ordinary current assets (HAO)",
  "6": "Inventories and work in progress",
  "7": "Trade receivables",
  "8": "Other receivables",
  "8A": "Impairment of current assets and cash",
  "9": "Short-term investments",
  "10": "Items for collection",
  "11": "Cash and cash equivalents",
  "12": "Translation differences",
  "12B": "Expenses transferred",
  "13": "Share capital",
  "14": "Share premiums, reserves and retained earnings",
  "14B": "Changes in equity for the year",
  "15": "Investment grants and regulated provisions",
  "16A": "Financial liabilities and similar resources",
  "16B": "Retirement benefit obligations and similar",
  "16C": "Maturity profile of receivables and payables",
  "17": "Trade payables",
  "18": "Tax and social security liabilities",
  "19": "Other payables and short-term provisions",
  "20": "Banks, discount and short-term credit facilities",
  "21": "Revenue and other income",
  "22": "Purchases and changes in inventories",
  "23": "Transport",
  "24": "External services",
  "25": "Taxes and duties, and income tax",
  "26": "Other expenses",
  "27A": "Staff costs",
  "27B": "Headcount, payroll costs and outside personnel",
  "28": "Depreciation, provisions and impairment: charges and reversals",
  "29": "Finance costs and financial income",
  "30": "Other non-ordinary expenses and income (HAO)",
  "31": "Appropriation of profit and five-year financial summary",
  "32": "Output for the year",
  "33": "Purchases for production",
  "34": "Summary of key financial indicators",
  "35": "Events after the reporting date",
  "36": "Commitments given and received (off balance sheet)",
  "37": "Related party transactions",
};

/**
 * Trames de rédaction des notes narratives, en anglais.
 *
 * Contrairement aux intitulés de postes, ces puces ne sont PAS du texte
 * réglementaire : ce sont les consignes de rédaction affichées sous la
 * bannière « brouillon à valider ». Elles sont donc traduites, et non glosées —
 * les laisser en français reviendrait à demander à un réviseur anglophone de
 * rédiger une note d'après un mode d'emploi qu'il ne lit pas.
 *
 * « À saisir : » devient « To be entered by hand: » : la phrase dit à chaque
 * fois pourquoi la balance ne suffit pas et d'où vient l'information.
 */
const NOTE_OUTLINES: Record<string, readonly string[]> = {
  "1": [
    "Secured debts: creditor, amount outstanding, nature of the security (mortgage, pledge of business assets, pledge of goods, statutory lien)",
    "Assets given as security: description and net carrying amount",
    "Start date and expiry date of each security",
    "To be entered by hand: the ledger does not tell a secured debt from an unsecured one; the information comes from the loan agreements and the security register",
  ],
  "2": [
    "Framework: revised SYSCOHADA, normal system or minimum cash-basis system",
    "Measurement of fixed assets and useful lives",
    "Measurement of inventories",
    "Translation of foreign currency transactions",
    "Changes in accounting policy and their effects",
  ],
  "3B": [
    "Leases in force: asset, start date, term, initial value, purchase option",
    "Gross value, accumulated depreciation and net value of assets held under finance leases",
    "Rentals outstanding, split between the capital portion (account 17) and the interest portion (account 672)",
    "To be entered by hand: the ledger carries the liability (17) and the asset (class 2 accounts), but no lease terms; these come from the fixed-asset module or from the contracts",
  ],
  "14B": [
    "Opening balance of each equity line: the prior-year column of notes 13, 14, 15 and 3E gives it",
    "Capital increases: new contributions in cash or in kind, capitalisation of reserves, conversion of debt",
    "Appropriation of the prior year's profit: transfers to reserves, retained earnings, dividends paid",
    "Capital reductions, owner's drawings, revaluation surplus arising in the year",
    "To be entered by hand: the ledger gives opening and closing balances, not the nature of each movement; the appropriation decision (minutes of the general meeting) is required",
  ],
  "16B": [
    "Method applied: provision on the balance sheet (account 196) or commitment disclosed off balance sheet",
    "Actuarial assumptions: discount rate, mortality table, staff turnover, salary growth, retirement age",
    "Obligation at the reporting date, charge for the year, benefits paid",
    "To be entered by hand: no actuarial valuation can be derived from the trial balance; it comes from the payroll module or from an actuary",
  ],
  "16C": [
    "Receivables: due within one year, due after one year — split of notes 7, 8 and 4",
    "Financial liabilities: due within one year, one to five years, after five years — split of note 16A",
    "Operating and other payables: due within one year, due after one year — split of notes 17, 18 and 19",
    "Receivables and payables past due and unsettled at the reporting date",
    "To be entered by hand: no account carries a maturity; it comes from the aged partner balances and the loan amortisation schedules, never from a flat allocation",
  ],
  "27B": [
    "Average headcount for the year by category (managers, supervisors, clerical staff, manual workers) and by sex",
    "Split between national and non-national staff",
    "Payroll costs by category and the related social security charges",
    "Outside personnel: headcount and cost (accounts 637 and 667)",
    "To be entered by hand: the trial balance gives the amounts (note 27A) but no headcount; the numbers come from the payroll module or the staff register",
  ],
  "31": [
    "Profit for the year and proposed appropriation: legal reserve, other reserves, retained earnings, dividends",
    "Dividend per share or per unit of capital",
    "Last five years: capital, revenue, net profit, headcount, equity",
    "To be entered by hand: the engine holds only the current and prior year; the three earlier years and the appropriation decision must be taken from the returns already filed",
  ],
  "34": [
    "Activity indicators: revenue (XB), value added (XC), gross operating surplus (XD)",
    "Profitability indicators: operating profit or loss (XE), net profit or loss (XI), overall self-financing capacity (FA of the cash flow statement)",
    "Structure indicators: equity (CP), long-term resources (DF), working capital, working capital requirement, net cash (ZH)",
    "Ratios and rates of change: the engine computes the lines, but the ratios themselves fall outside the one-line-one-amount model and must be produced and commented on",
  ],
  "35": [
    "Events between the reporting date and the approval of the accounts",
    "Effect on the financial statements",
    "Going concern",
  ],
  "36": [
    "Financing commitments obtained and granted (accounts 901 and 905)",
    "Guarantee commitments obtained and granted: sureties, avals, mortgages granted (accounts 902 and 906)",
    "Discounted bills not yet matured, operating lease commitments, firm orders for fixed assets",
    "Unfunded retirement obligations: see note 16B",
    "To be entered by hand: commitments are recorded only if the company keeps class 9 accounts, which the engine carries into no statement; a commitment absent from the trial balance is indistinguishable from one that does not exist, so it must be confirmed rather than inferred",
  ],
  "37": [
    "Identification of related parties: parent, subsidiaries, entities under common control, directors and their close family",
    "Balances at the reporting date: accounts 26, 27, 18, 46 (shareholders and group) — to be split by related party",
    "Transactions for the year: sales, purchases, loans, guarantees, directors' remuneration",
    "Terms of the transactions: price, maturities, security, and disclosure of any terms other than arm's length",
    "To be entered by hand: the chart of accounts identifies group accounts but neither the related parties themselves nor the terms of the transactions",
  ],
};

/** Glose anglaise du titre des quatre états. */
const STATEMENT_TITLES: Record<string, string> = {
  BILAN_ACTIF: "Balance sheet – Assets",
  BILAN_PASSIF: "Balance sheet – Equity and liabilities",
  COMPTE_RESULTAT: "Income statement",
  TFT: "Cash flow statement",
};

/** Glose anglaise d'un poste, ou `undefined` si le code n'est pas au référentiel. */
export function statementLineGloss(code: string): string | undefined {
  return STATEMENT_LINES[code];
}

/** Glose anglaise d'une note annexe, ou `undefined`. */
export function noteTitleGloss(number: string | number): string | undefined {
  return NOTE_TITLES[String(number)];
}

/** Trame de rédaction anglaise d'une note narrative, ou `undefined`. */
export function noteOutlineEn(number: string | number): readonly string[] | undefined {
  return NOTE_OUTLINES[String(number)];
}

/** Glose anglaise du titre d'un état, ou `undefined`. */
export function statementTitleGloss(code: string): string | undefined {
  return STATEMENT_TITLES[code];
}

/**
 * Libellés de lignes de notes, français → anglais.
 *
 * Contrairement aux intitulés de postes, ces libellés ne sont PAS
 * réglementaires : ce sont les descriptions des lignes que le générateur
 * calcule à partir de la balance. Ils sont donc TRADUITS, et non glosés —
 * imprimer « Production vendue : produits fabriqués » dans une note anglaise
 * n'apporterait rien à un lecteur anglophone et ne rassurerait aucun
 * contrôleur, puisque le formulaire officiel ne prescrit pas ces lignes-là.
 *
 * Le registre est le même que celui des gloses : anglais IFRS, orthographe
 * britannique. Quelques termes tiennent à l'espace OHADA et n'ont pas
 * d'équivalent : « HAO » est conservé entre parenthèses.
 *
 * Une ligne ajoutée au référentiel sans son anglais fait échouer le garde-fou
 * de complétude (packages/render/src/render.test.ts) plutôt que d'imprimer du
 * français au milieu d'une note anglaise.
 */
const NOTE_ROWS: Record<string, string> = {
  "Achats d'emballages": "Purchases of packaging",
  "Achats de marchandises": "Purchases of goods for resale",
  "Achats de matières premières et fournitures liées": "Purchases of raw materials and related supplies",
  "Achats stockés de matières et fournitures consommables": "Purchases of consumable materials and supplies held in inventory",
  "Actions et obligations": "Shares and bonds",
  "Amortissements des bâtiments, installations et agencements": "Depreciation of buildings, installations and fixtures",
  "Amortissements des immobilisations incorporelles": "Amortisation of intangible assets",
  "Amortissements des terrains": "Depreciation of land",
  "Amortissements du matériel, mobilier et actifs biologiques": "Depreciation of plant, furniture and biological assets",
  "Amortissements dérogatoires": "Tax-driven accelerated depreciation",
  "Apporteurs, capital souscrit non appelé (−)": "Contributors, subscribed capital not called (−)",
  "Associés et groupe": "Shareholders and group companies",
  "Autres achats (eau, électricité, petit matériel, études)": "Other purchases (water, electricity, small equipment, studies)",
  "Autres achats consommés": "Other purchases consumed",
  "Autres approvisionnements": "Other supplies",
  "Autres charges de personnel": "Other employee costs",
  "Autres comptes HAO à solde débiteur": "Other non-ordinary (HAO) accounts with a debit balance",
  "Autres comptes clients à solde débiteur": "Other customer accounts with a debit balance",
  "Autres comptes fournisseurs à solde créditeur": "Other supplier accounts with a credit balance",
  "Autres créances hors activités ordinaires": "Other non-ordinary (HAO) receivables",
  "Autres immobilisations financières": "Other non-current financial assets",
  "Autres immobilisations financières et intérêts courus": "Other non-current financial assets and accrued interest",
  "Autres impôts et taxes": "Other taxes and duties",
  "Autres produits": "Other income",
  "Autres produits de cession": "Other disposal proceeds",
  "Autres provisions réglementées et fonds assimilés": "Other regulated provisions and similar funds",
  "Autres services extérieurs": "Other external services",
  "Autres subventions d'investissement": "Other capital grants",
  "Autres titres de participation": "Other equity investments",
  "Autres valeurs à l'encaissement": "Other items for collection",
  "Autres écarts de réévaluation": "Other revaluation differences",
  "Avances et acomptes versés sur immobilisations": "Advances and down payments on fixed assets",
  "Avances, dépôts et cautionnements reçus, autres emprunts": "Advances, deposits and guarantees received, other borrowings",
  "Banques": "Banks",
  "Banques et établissements financiers, soldes créditeurs": "Banks and financial institutions, credit balances",
  "Bons de souscription et titres négociables hors région": "Subscription warrants and marketable securities outside the region",
  "Bâtiments, installations techniques et agencements": "Buildings, technical installations and fixtures",
  "Caisse": "Cash on hand",
  "Caisse, solde créditeur": "Cash on hand, credit balance",
  "Capital par dotation": "Endowment capital",
  "Capital personnel": "Proprietor's capital",
  "Capital social": "Share capital",
  "Cartes de crédit à encaisser": "Credit card receipts awaiting collection",
  "Charges diverses": "Sundry expenses",
  "Charges hors activités ordinaires": "Non-ordinary expenses (HAO)",
  "Charges provisionnées d'exploitation": "Operating expenses provided for",
  "Charges sociales": "Social security contributions",
  "Chèques à encaisser et à l'encaissement": "Cheques held and cheques in course of collection",
  "Clients": "Trade receivables",
  "Clients créditeurs à solde débiteur": "Customer credit accounts with a debit balance",
  "Clients, avances et acomptes reçus": "Customers, advances and down payments received",
  "Clients, créances litigieuses ou douteuses": "Customers, disputed or doubtful receivables",
  "Clients, effets à recevoir en portefeuille": "Customers, bills receivable held",
  "Clients, produits à recevoir": "Customers, accrued income",
  "Compte de l'exploitant": "Proprietor's current account",
  "Créances sur cessions d'immobilisations": "Receivables on disposals of fixed assets",
  "Créances sur cessions de titres de placement": "Receivables on disposals of short-term investments",
  "Créances sur l'État et titres immobilisés": "Receivables from the State and non-current securities",
  "Créditeurs divers et comptes de régularisation": "Sundry payables and accruals",
  "Crédits de trésorerie et intérêts courus": "Short-term credit facilities and accrued interest",
  "Dettes circulantes hors activités ordinaires": "Non-ordinary current liabilities (HAO)",
  "Dettes de location-acquisition": "Lease liabilities",
  "Dettes liées à des participations et comptes de liaison": "Liabilities to investees and inter-company accounts",
  "Dotations aux amortissements, aux provisions et aux dépréciations d'exploitation": "Operating depreciation, provisions and impairment charges",
  "Dotations aux amortissements, aux provisions et aux dépréciations financières": "Financial depreciation, provisions and impairment charges",
  "Dotations hors activités ordinaires": "Non-ordinary (HAO) charges to provisions and impairment",
  "Droits d'enregistrement": "Registration duties",
  "Débiteurs divers et comptes de régularisation": "Sundry receivables and prepayments",
  "Dépréciations des autres créances": "Impairment of other receivables",
  "Dépréciations des comptes clients": "Impairment of trade receivables",
  "Dépréciations des comptes de trésorerie": "Impairment of cash and cash equivalents",
  "Dépréciations des comptes fournisseurs": "Impairment of supplier accounts",
  "Dépréciations des créances hors activités ordinaires": "Impairment of non-ordinary (HAO) receivables",
  "Dépréciations des immobilisations financières et avances": "Impairment of non-current financial assets and advances",
  "Dépréciations des stocks et encours": "Impairment of inventories and work in progress",
  "Dépréciations des titres de placement": "Impairment of short-term investments",
  "Dépréciations des valeurs à encaisser": "Impairment of items for collection",
  "Dépôts et cautionnements versés": "Deposits and guarantees paid",
  "Effets à encaisser et à l'encaissement": "Bills held and bills in course of collection",
  "Emprunts et dettes auprès des établissements de crédit": "Borrowings and liabilities to credit institutions",
  "Emprunts obligataires": "Bond issues",
  "Entretien, réparations et maintenance": "Upkeep, repairs and maintenance",
  "Escompte de crédits de campagne et de crédits ordinaires": "Discounting of seasonal and ordinary credit facilities",
  "Escomptes accordés et autres intérêts": "Discounts granted and other interest",
  "Escomptes obtenus et revenus de titres": "Discounts obtained and investment income",
  "Fournisseurs débiteurs à solde créditeur": "Supplier debit accounts with a credit balance",
  "Fournisseurs, avances et acomptes versés": "Suppliers, advances and down payments paid",
  "Fournisseurs, dettes en compte": "Suppliers, open account balances",
  "Fournisseurs, effets à payer": "Suppliers, bills payable",
  "Fournisseurs, factures non parvenues": "Suppliers, invoices not yet received",
  "Frais bancaires": "Bank charges",
  "Gains de change et autres revenus financiers": "Foreign exchange gains and other financial income",
  "Honoraires, formation, redevances, cotisations": "Professional fees, training, royalties and subscriptions",
  "Immobilisations incorporelles": "Intangible assets",
  "Impôts et taxes directs": "Direct taxes and duties",
  "Impôts et taxes indirects": "Indirect taxes and duties",
  "Impôts sur le résultat (exercice, rappels, impôt minimum forfaitaire)": "Income tax (current year, reassessments, minimum flat-rate tax)",
  "Indemnités forfaitaires versées au personnel": "Flat-rate allowances paid to employees",
  "Instruments de trésorerie": "Treasury instruments",
  "Intérêts courus et autres valeurs assimilées": "Accrued interest and similar items",
  "Intérêts de prêts et revenus de participations": "Interest on loans and income from equity investments",
  "Intérêts des emprunts et des dettes de location-acquisition": "Interest on borrowings and lease liabilities",
  "Locations et charges locatives": "Rent and rental charges",
  "Marchandises": "Goods for resale",
  "Matières premières et fournitures liées": "Raw materials and related supplies",
  "Matériel, mobilier et actifs biologiques": "Plant, furniture and biological assets",
  "Organismes internationaux": "International bodies",
  "Organismes sociaux": "Social security bodies",
  "Participation des travailleurs": "Employee profit-sharing",
  "Personnel": "Employees",
  "Personnel extérieur": "Agency and seconded staff",
  "Pertes de change et autres charges financières": "Foreign exchange losses and other finance costs",
  "Pertes sur créances clients et autres débiteurs": "Losses on trade and other receivables",
  "Plus-values de cession à réinvestir et fonds réglementés": "Disposal gains to be reinvested and regulated funds",
  "Primes d'assurance": "Insurance premiums",
  "Primes liées au capital social": "Share premiums and similar",
  "Production immobilisée": "Own work capitalised",
  "Production stockée (ou déstockage)": "Change in inventories of finished goods and work in progress",
  "Production vendue : produits accessoires": "Revenue from production sold: ancillary products",
  "Production vendue : produits fabriqués": "Revenue from production sold: manufactured goods",
  "Production vendue : travaux et services": "Revenue from production sold: works and services",
  "Produits accessoires": "Ancillary income",
  "Produits des cessions d'immobilisations corporelles": "Proceeds from disposals of property, plant and equipment",
  "Produits des cessions d'immobilisations financières": "Proceeds from disposals of non-current financial assets",
  "Produits des cessions d'immobilisations incorporelles": "Proceeds from disposals of intangible assets",
  "Produits et services en cours": "Work in progress: goods and services",
  "Produits finis, intermédiaires et résiduels": "Finished, intermediate and residual products",
  "Produits hors activités ordinaires": "Non-ordinary income (HAO)",
  "Provisions pour risques et charges": "Provisions for liabilities and charges",
  "Provisions pour risques à court terme": "Provisions for short-term risks",
  "Prêts et créances non commerciales, prêts au personnel": "Loans and non-trade receivables, staff loans",
  "Pénalités et amendes fiscales": "Tax penalties and fines",
  "Quotes-parts de résultat sur opérations faites en commun": "Share of profit or loss on jointly conducted operations",
  "Report à nouveau (+ ou −)": "Retained earnings (+ or −)",
  "Reprises d'amortissements, de provisions et de dépréciations d'exploitation": "Operating reversals of depreciation, provisions and impairment",
  "Reprises de provisions et de dépréciations financières": "Financial reversals of provisions and impairment",
  "Reprises hors activités ordinaires": "Non-ordinary (HAO) reversals",
  "Régies d'avances, accréditifs et virements internes": "Imprest accounts, letters of credit and internal transfers",
  "Rémunération et charges sociales de l'exploitant individuel": "Sole proprietor's remuneration and social security contributions",
  "Rémunération transférée de personnel extérieur": "Recharged cost of agency and seconded staff",
  "Rémunérations directes versées au personnel national": "Direct remuneration paid to national employees",
  "Rémunérations directes versées au personnel non national": "Direct remuneration paid to non-national employees",
  "Réserve légale": "Legal reserve",
  "Réserves libres": "Free reserves",
  "Réserves statutaires, contractuelles et réglementées": "Statutory, contractual and regulated reserves",
  "Sous-traitance générale": "General subcontracting",
  "Stocks en cours de route, en consignation ou en dépôt": "Inventories in transit, on consignment or on deposit",
  "Subventions d'exploitation": "Operating grants",
  "Subventions d'équilibre": "Balancing grants",
  "Subventions d'équipement": "Capital equipment grants",
  "Terrains": "Land",
  "Titres de participation": "Equity investments",
  "Titres de participation conférant une influence notable": "Equity investments conferring significant influence",
  "Titres de participation dans des sociétés sous contrôle exclusif ou conjoint": "Equity investments in entities under exclusive or joint control",
  "Titres du Trésor et bons de caisse à court terme": "Treasury bills and short-term deposit notes",
  "Transferts de charges d'exploitation": "Operating expenses transferred",
  "Transferts de charges financières": "Finance costs transferred",
  "Transports de plis et autres frais de transport": "Courier and other transport costs",
  "Transports du personnel": "Employee transport",
  "Transports pour le compte de tiers": "Transport on behalf of third parties",
  "Transports sur achats": "Inward carriage",
  "Transports sur ventes": "Outward carriage",
  "Travaux, services vendus": "Works and services sold",
  "Valeurs comptables des cessions courantes d'immobilisations": "Carrying amount of fixed assets disposed of in the ordinary course",
  "Valeurs comptables des immobilisations cédées": "Carrying amount of fixed assets disposed of",
  "Variation des stocks d'autres approvisionnements": "Change in inventories of other supplies",
  "Variation des stocks de marchandises": "Change in inventories of goods for resale",
  "Variation des stocks de matières premières et fournitures liées": "Change in inventories of raw materials and related supplies",
  "Ventes de marchandises": "Sales of goods for resale",
  "Ventes de produits fabriqués": "Sales of manufactured goods",
  "Écart de conversion – Actif (perte latente)": "Translation difference – Assets (unrealised loss)",
  "Écart de conversion – Passif (gain latent)": "Translation difference – Equity and liabilities (unrealised gain)",
  "Écarts de réévaluation libre": "Voluntary revaluation differences",
  "Écarts de réévaluation légale": "Statutory revaluation differences",
  "Établissements financiers, mobile money et assimilés": "Financial institutions, mobile money and similar",
  "État et collectivités publiques": "State and public authorities",
  "État, TVA": "State, VAT",
  "État, autres impôts, taxes et retenues": "State, other taxes, duties and withholdings",
  "État, impôt sur les bénéfices": "State, income tax",
  "Études, publicité, télécommunications": "Studies, advertising and telecommunications",
};

/**
 * Anglais d'une ligne de note. `undefined` si la ligne n'a pas été traduite :
 * l'appelant imprime alors le français, et le garde-fou de complétude fait
 * échouer la construction.
 */
export function noteRowEn(label: string): string | undefined {
  return NOTE_ROWS[label];
}

/** Toutes les lignes traduites, pour le garde-fou de complétude. */
export function translatedNoteRows(): readonly string[] {
  return Object.keys(NOTE_ROWS);
}
