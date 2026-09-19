import type { Money } from "@arcompt/ledger";

/**
 * Types d'entrée « plats » des gabarits. Les autres modules (facturation,
 * paie, trésorerie) projettent leurs objets métier vers ces vues ; le paquet
 * de rendu ne dépend ainsi d'aucun schéma de base.
 *
 * Tout montant est un `Money` ou sa chaîne canonique ("1234.5000") ; il est
 * normalisé par `Money.parse` au rendu. Jamais de nombre flottant.
 */
export type Amount = Money | string;

export type Locale = "fr" | "en";

/** Identifiant légal ou fiscal : { label: "NCC", value: "1234567A" }, RCCM, NIF… */
export interface Identifier {
  label: string;
  value: string;
}

/** En-tête d'entreprise imprimé sur tous les documents. */
export interface CompanyHeader {
  name: string;
  /** Forme juridique (SARL, SA, SAS, EI…). */
  legalForm?: string;
  capital?: Amount;
  identifiers?: Identifier[];
  address?: string;
  city?: string;
  country?: string;
  phone?: string;
  email?: string;
  /** Logo en data URI (PNG/SVG) ; facultatif. */
  logoDataUri?: string;
}

export interface RenderOptions {
  locale?: Locale;
  company?: CompanyHeader;
  /** Horodatage ISO imprimé en pied de page (défaut : maintenant). */
  generatedAt?: string;
  /** Filigrane : « BROUILLON », « COPIE »… */
  watermark?: string;
}

/* ------------------------------------------------------------------ */
/* Balance générale                                                     */
/* ------------------------------------------------------------------ */

export interface TrialBalanceRowView {
  accountNumber: string;
  label: string;
  debit: Amount;
  credit: Amount;
}

export interface TrialBalanceView {
  fiscalYearCode: string;
  from: string;
  to: string;
  currency: string;
  rows: TrialBalanceRowView[];
  totalDebit: Amount;
  totalCredit: Amount;
}

/* ------------------------------------------------------------------ */
/* Grand livre                                                          */
/* ------------------------------------------------------------------ */

export interface LedgerLineView {
  date: string;
  journalCode: string;
  /** Numéro d'écriture dans le journal. */
  entryNumber: number | null;
  reference: string | null;
  label: string;
  debit: Amount;
  credit: Amount;
  partnerId?: string;
}

export interface LedgerAccountView {
  accountNumber: string;
  label: string;
  lines: LedgerLineView[];
  totalDebit: Amount;
  totalCredit: Amount;
  /** Solde D − C (positif = débiteur). */
  balance: Amount;
}

export interface LedgerView {
  fiscalYearCode: string;
  from: string;
  to: string;
  currency: string;
  accounts: LedgerAccountView[];
}

/* ------------------------------------------------------------------ */
/* Facture de vente                                                     */
/* ------------------------------------------------------------------ */

export interface PartyView {
  name: string;
  address?: string;
  city?: string;
  country?: string;
  identifiers?: Identifier[];
  phone?: string;
  email?: string;
}

export interface InvoiceLineView {
  description: string;
  /** Quantité en chaîne décimale ("2", "1.5"). */
  quantity: string;
  unit?: string;
  unitPrice: Amount;
  /** Remise sur la ligne (montant HT), facultative. */
  discount?: Amount;
  /** Taux de TVA en pourcentage ("18", "0"). */
  vatRate: string;
  totalHt: Amount;
  vatAmount: Amount;
  totalTtc: Amount;
}

export interface VatSummaryView {
  rate: string;
  base: Amount;
  amount: Amount;
}

export interface MobileMoneyView {
  /** Opérateur : Orange Money, MTN MoMo, Wave, Moov Money… */
  operator: string;
  number: string;
  holder?: string;
}

export interface BankDetailsView {
  bankName: string;
  /** RIB / IBAN selon le pays. */
  iban?: string;
  rib?: string;
  bic?: string;
  holder?: string;
}

export interface InvoiceView {
  kind?: "INVOICE" | "CREDIT_NOTE" | "PROFORMA";
  number: string;
  issueDate: string;
  dueDate?: string;
  deliveryDate?: string;
  /** Référence commande ou facture d'origine (avoir). */
  reference?: string;
  currency: string;
  seller: PartyView;
  buyer: PartyView;
  lines: InvoiceLineView[];
  /** Calculé depuis les lignes si absent. */
  vatSummary?: VatSummaryView[];
  totalHt: Amount;
  totalVat: Amount;
  /** Autres taxes (AIRSI, taxes spécifiques…). */
  otherTaxes?: Array<{ label: string; amount: Amount }>;
  totalTtc: Amount;
  /** Déjà réglé, le cas échéant. */
  amountPaid?: Amount;
  /** Certification électronique (FNE, e-MECeF, DGI…). */
  certification?: {
    system?: string;
    reference?: string;
    /** Contenu à encoder ; affiché en clair si l'image QR n'est pas fournie. */
    qrData?: string;
    /** Image QR en data URI si déjà générée par le module. */
    qrDataUri?: string;
    verifyUrl?: string;
  };
  payment?: {
    terms?: string;
    bank?: BankDetailsView;
    mobileMoney?: MobileMoneyView[];
  };
  /** Mentions légales spécifiques (pénalités de retard, escompte, clause de réserve…). */
  legalMentions?: string[];
  notes?: string;
}

/* ------------------------------------------------------------------ */
/* Bulletin de paie                                                     */
/* ------------------------------------------------------------------ */

export interface PayslipItemView {
  label: string;
  base?: Amount;
  /** Taux en pourcentage ("6.3") ou coefficient libre ("1.5"). */
  rate?: string;
  amount: Amount;
}

export interface PayslipContributionView {
  label: string;
  base: Amount;
  employeeRate?: string;
  employeeAmount: Amount;
  employerRate?: string;
  employerAmount: Amount;
}

export interface PayslipView {
  employee: {
    fullName: string;
    employeeNumber?: string;
    jobTitle?: string;
    category?: string;
    hireDate?: string;
    /** Numéro de sécurité sociale (CNPS, CNSS…). */
    socialSecurityNumber?: string;
    address?: string;
  };
  period: { start: string; end: string; label?: string };
  currency: string;
  paymentDate?: string;
  paymentMode?: string;
  /** Heures ou jours travaillés, facultatif. */
  workedTime?: string;
  earnings: PayslipItemView[];
  grossPay: Amount;
  contributions: PayslipContributionView[];
  totalEmployeeContributions: Amount;
  totalEmployerContributions: Amount;
  /** Impôt sur les traitements et salaires (ITS / IRPP / IUTS selon le pays). */
  incomeTax: PayslipItemView[];
  otherDeductions?: PayslipItemView[];
  /** Éléments non soumis (indemnités de transport…), ajoutés au net. */
  nonTaxableAllowances?: PayslipItemView[];
  netPay: Amount;
  employerCost: Amount;
  cumulative?: { grossPay: Amount; netPay: Amount; incomeTax: Amount };
  leaveBalanceDays?: string;
}

/* ------------------------------------------------------------------ */
/* Rapprochement bancaire                                               */
/* ------------------------------------------------------------------ */

export interface ReconciliationItemView {
  date: string;
  label: string;
  reference?: string;
  /** Signé : positif = entrée de fonds. */
  amount: Amount;
}

export interface BankReconciliationView {
  bankAccount: { label: string; ledgerAccount: string; bankName?: string; iban?: string };
  period: { start: string; end: string };
  currency: string;
  /** Solde du relevé bancaire à la date de fin. */
  statementBalance: Amount;
  /** Solde du compte 52x au grand livre. */
  ledgerBalance: Amount;
  /** Au grand livre, pas encore sur le relevé (chèques émis, remises en transit). */
  ledgerOnly: ReconciliationItemView[];
  /** Sur le relevé, pas encore au grand livre (frais, agios, virements reçus). */
  bankOnly: ReconciliationItemView[];
  /** Soldes ajustés calculés par le module trésorerie. */
  adjustedStatementBalance: Amount;
  adjustedLedgerBalance: Amount;
  matchedCount?: number;
}
