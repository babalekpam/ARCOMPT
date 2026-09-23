import type { Money } from "@arcompt/ledger";

export type Id = string;

export type ContractType = "CDI" | "CDD" | "STAGE" | "JOURNALIER" | "AUTRE";

/** Élément de rémunération récurrent (prime de transport, logement…). */
export interface Allowance {
  code: string;
  label: string;
  /** Montant mensuel, chaîne décimale. */
  amount: string;
  /** Soumis aux cotisations et à l'impôt (défaut true). Un élément non imposable est ajouté au net seulement. */
  taxable?: boolean;
}

export interface BankDetails {
  bank?: string;
  iban?: string;
  rib?: string;
  /** Portefeuille mobile money (numéro) si paiement hors banque. */
  mobileMoney?: string;
}

/** Salarié tel que manipulé par le service (champs sensibles déchiffrés). */
export interface Employee {
  id: Id;
  tenantId: Id;
  partnerId: Id;
  matricule: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  leaveDate: string | null;
  contractType: ContractType;
  category: string | null;
  /** Salaire de base mensuel (déchiffré), chaîne décimale. */
  baseSalary: string;
  allowances: Allowance[];
  bankDetails: BankDetails | null;
  socialSecurityNumber: string | null;
  taxId: string | null;
  dependants: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeInput {
  matricule: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  leaveDate?: string;
  contractType?: ContractType;
  category?: string;
  baseSalary: string;
  allowances?: Allowance[];
  bankDetails?: BankDetails;
  socialSecurityNumber?: string;
  taxId?: string;
  dependants?: number;
}

export type EmployeePatch = Partial<EmployeeInput> & { active?: boolean };

export interface PayrollPeriod {
  year: number;
  month: number;
}

/** Variables du mois saisies pour un salarié (toutes optionnelles, chaînes décimales). */
export interface PayslipInputs {
  /** Heures supplémentaires, montant déjà valorisé. */
  overtime?: string;
  /** Primes exceptionnelles du mois (soumises). */
  bonuses?: Array<{ label: string; amount: string }>;
  /** Retenues avant cotisations (absences, retards…). */
  deductions?: Array<{ label: string; amount: string }>;
  /** Acompte déjà versé dans le mois (compte 421), déduit du net à payer. */
  advance?: string;
  /** Variables supplémentaires transmises telles quelles aux règles du pack (ex. plafond_cnps). */
  variables?: Record<string, string>;
}

export type PayslipLineKind = "EARNING" | "DEDUCTION" | "CONTRIBUTION" | "TAX" | "ADVANCE";

/** Ligne de bulletin, stockée en jsonb ; montants en chaînes décimales canoniques. */
export interface PayslipLine {
  id: string;
  kind: PayslipLineKind;
  label: string;
  /** Assiette (brut, base plafonnée, base imposable…). */
  base: string;
  /** Taux salarial si connu (chaîne décimale), sinon null (barème). */
  rate: string | null;
  /** Montant côté salarié : gain (EARNING) ou retenue (CONTRIBUTION, TAX, DEDUCTION, ADVANCE). */
  employee_amount: string;
  /** Part patronale (CONTRIBUTION uniquement). */
  employer_amount: string;
  /** Compte SYSCOHADA d'imputation. */
  account: string;
  /** Identifiant de règle du pack ayant produit la ligne (traçabilité). */
  rule_id?: string;
}

/** Résultat du calcul pur d'un bulletin. */
export interface PayslipComputation {
  period: PayrollPeriod;
  /** Date de référence des règles (dernier jour du mois). */
  date: string;
  currency: string;
  packVersion: string;
  gross: Money;
  taxableBase: Money;
  employeeContributions: Money;
  employerContributions: Money;
  incomeTax: Money;
  /** Net après retenues et impôt, avant acompte. */
  net: Money;
  advance: Money;
  netToPay: Money;
  employerCost: Money;
  lines: PayslipLine[];
}

export type PayrollRunStatus = "DRAFT" | "COMPUTED" | "VALIDATED" | "PAID";

export interface PayrollRun {
  id: Id;
  tenantId: Id;
  year: number;
  month: number;
  status: PayrollRunStatus;
  packVersion: string;
  employeeCount: number;
  totalGross: string;
  totalEmployeeContributions: string;
  totalEmployerContributions: string;
  totalIncomeTax: string;
  totalNet: string;
  totalEmployerCost: string;
  entryId: Id | null;
  paymentEntryId: Id | null;
  createdAt: string;
  computedAt: string | null;
  validatedAt: string | null;
  paidAt: string | null;
}

export interface Payslip {
  id: Id;
  tenantId: Id;
  runId: Id;
  employeeId: Id;
  currency: string;
  gross: string;
  taxableBase: string;
  employeeContributions: string;
  employerContributions: string;
  incomeTax: string;
  net: string;
  advance: string;
  netToPay: string;
  employerCost: string;
  lines: PayslipLine[];
  inputs: PayslipInputs;
  pdfDocumentId: Id | null;
  computedAt: string;
}

/** Données prêtes à rendre (bulletin PDF / écran). */
export interface PayslipView {
  payslip: Payslip;
  run: { id: Id; year: number; month: number; status: PayrollRunStatus; periodLabel: string; packVersion: string };
  company: { id: Id; name: string; countryCode: string; currency: string; taxIds: Record<string, unknown> };
  employee: {
    id: Id;
    matricule: string;
    fullName: string;
    hireDate: string;
    contractType: ContractType;
    category: string | null;
    socialSecurityNumber: string | null;
    dependants: number;
    bankDetails: BankDetails | null;
  };
  /** Lignes groupées par nature, avec montants formatés dans la devise. */
  sections: {
    earnings: Array<PayslipLine & { formatted: string }>;
    deductions: Array<PayslipLine & { formatted: string }>;
    contributions: Array<PayslipLine & { formatted: string; formattedEmployer: string }>;
    taxes: Array<PayslipLine & { formatted: string }>;
    advances: Array<PayslipLine & { formatted: string }>;
  };
  totals: Record<"gross" | "taxableBase" | "employeeContributions" | "employerContributions" | "incomeTax" | "net" | "advance" | "netToPay" | "employerCost", string>;
  /**
   * Vrai seulement si le pack pays est PUBLISHED et revu. Un bulletin n'est pas
   * refusé sur un pack en cours de rédaction — c'est aussi une pièce
   * comptable, et le refuser rendrait la paie inutilisable — mais il ne doit
   * pas laisser croire que les cotisations affichées font autorité :
   * `packNotice` est la mention à imprimer, en clair, sur l'écran et le PDF.
   */
  official: boolean;
  packNotice: string | null;
}

/** Ligne du livre de paie : un salarié × un mois. */
export interface PayrollBookRow {
  employeeId: Id;
  matricule: string;
  fullName: string;
  year: number;
  month: number;
  runStatus: PayrollRunStatus;
  gross: string;
  employeeContributions: string;
  employerContributions: string;
  incomeTax: string;
  net: string;
  netToPay: string;
  employerCost: string;
}

export interface PayrollBook {
  year: number;
  currency: string;
  rows: PayrollBookRow[];
  /** Totaux par mois (1..12) pour les mois ayant un cycle validé ou payé. */
  months: Array<{ month: number; employees: number } & Record<"gross" | "employeeContributions" | "employerContributions" | "incomeTax" | "net" | "employerCost", string>>;
  totals: Record<"gross" | "employeeContributions" | "employerContributions" | "incomeTax" | "net" | "employerCost", string>;
}

export type DeclarationStatus = "DRAFT" | "FILED" | "PAID";

export interface PayrollDeclaration {
  id: Id;
  tenantId: Id;
  kind: string;
  label: string;
  year: number;
  month: number;
  base: string;
  employeeAmount: string;
  employerAmount: string;
  amount: string;
  account: string;
  status: DeclarationStatus;
  filingReference: string | null;
  filedAt: string | null;
  /**
   * Faux quand la déclaration a été produite depuis un pack pays non PUBLISHED,
   * sous `ALLOW_INSECURE_DRAFT_PACK_FILINGS=1` : document non officiel.
   */
  official: boolean;
}
