/**
 * Types des réponses de l'API paie (/v1/payroll), copiés du paquet serveur.
 * Les montants sont des chaînes décimales ; les champs sensibles peuvent
 * arriver masqués ("***", "****1234") selon le rôle.
 */
export type ContractType = "CDI" | "CDD" | "STAGE" | "JOURNALIER" | "AUTRE";
export const CONTRACT_TYPES: ContractType[] = ["CDI", "CDD", "STAGE", "JOURNALIER", "AUTRE"];

export interface Allowance {
  code: string;
  label: string;
  amount: string;
  taxable?: boolean;
}

export interface BankDetails {
  bank?: string;
  iban?: string;
  rib?: string;
  mobileMoney?: string;
}

export interface Employee {
  id: string;
  tenantId: string;
  partnerId: string;
  matricule: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  leaveDate: string | null;
  contractType: ContractType;
  category: string | null;
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

export interface PayslipInputs {
  overtime?: string;
  bonuses?: Array<{ label: string; amount: string }>;
  deductions?: Array<{ label: string; amount: string }>;
  advance?: string;
  variables?: Record<string, string>;
}

export type PayslipLineKind = "EARNING" | "DEDUCTION" | "CONTRIBUTION" | "TAX" | "ADVANCE";

export interface PayslipLine {
  id: string;
  kind: PayslipLineKind;
  label: string;
  base: string;
  rate: string | null;
  employee_amount: string;
  employer_amount: string;
  account: string;
  rule_id?: string;
}

export type PayrollRunStatus = "DRAFT" | "COMPUTED" | "VALIDATED" | "PAID";

export interface PayrollRun {
  id: string;
  tenantId: string;
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
  entryId: string | null;
  paymentEntryId: string | null;
  createdAt: string;
  computedAt: string | null;
  validatedAt: string | null;
  paidAt: string | null;
}

export interface Payslip {
  id: string;
  tenantId: string;
  runId: string;
  employeeId: string;
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
  pdfDocumentId: string | null;
  computedAt: string;
}

export type PayslipTotals = Record<"gross" | "taxableBase" | "employeeContributions" | "employerContributions" | "incomeTax" | "net" | "advance" | "netToPay" | "employerCost", string>;

export interface PayslipView {
  payslip: Payslip;
  run: { id: string; year: number; month: number; status: PayrollRunStatus; periodLabel: string; packVersion: string };
  company: { id: string; name: string; countryCode: string; currency: string; taxIds: Record<string, unknown> };
  employee: {
    id: string;
    matricule: string;
    fullName: string;
    hireDate: string;
    contractType: ContractType;
    category: string | null;
    socialSecurityNumber: string | null;
    dependants: number;
    bankDetails: BankDetails | null;
  };
  sections: {
    earnings: Array<PayslipLine & { formatted: string }>;
    deductions: Array<PayslipLine & { formatted: string }>;
    contributions: Array<PayslipLine & { formatted: string; formattedEmployer: string }>;
    taxes: Array<PayslipLine & { formatted: string }>;
    advances: Array<PayslipLine & { formatted: string }>;
  };
  totals: PayslipTotals;
}

export interface PayrollBookRow {
  employeeId: string;
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

export type BookTotals = Record<"gross" | "employeeContributions" | "employerContributions" | "incomeTax" | "net" | "employerCost", string>;

export interface PayrollBook {
  year: number;
  currency: string;
  rows: PayrollBookRow[];
  months: Array<{ month: number; employees: number } & BookTotals>;
  totals: BookTotals;
}

export type DeclarationStatus = "DRAFT" | "FILED" | "PAID";

export interface PayrollDeclaration {
  id: string;
  tenantId: string;
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
}
