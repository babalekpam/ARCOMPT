// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Types des réponses API utilisés par le front. Copiés (et non importés) des
 * paquets serveur : les montants sont des chaînes canoniques à 4 décimales.
 */
export type EntryStatus = "DRAFT" | "VALIDATED";

export interface JournalLine {
  id: string;
  entryId: string;
  lineNo: number;
  accountId: string;
  accountNumber: string;
  partnerId: string | null;
  label: string;
  debit: string;
  credit: string;
  currency: string;
  rate: string | null;
  analyticCode: string | null;
  vatCode: string | null;
}

export interface JournalEntry {
  id: string;
  tenantId: string;
  journalCode: string;
  number: number | null;
  date: string;
  reference: string | null;
  label: string;
  status: EntryStatus;
  source: string;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  hash: string | null;
  createdAt: string;
  validatedAt: string | null;
  lines: JournalLine[];
}

export interface AccountBalanceRow {
  accountNumber: string;
  label: string;
  class: number;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  tenantId: string;
  fiscalYearCode: string;
  from: string;
  to: string;
  rows: AccountBalanceRow[];
  totalDebit: string;
  totalCredit: string;
}

export interface ChainReport {
  ok: boolean;
  brokenAt?: string;
  checked: number;
}

export interface Account {
  id: string;
  number: string;
  label: string;
  class: number;
  nature: string;
  lettrable: boolean;
  postable: boolean;
  active: boolean;
}

export type StatementCode = "BILAN_ACTIF" | "BILAN_PASSIF" | "COMPTE_RESULTAT" | "TFT";

export interface ComputedLine {
  code: string;
  label: string;
  /**
   * Glose anglaise de l'intitulé, fournie par l'API. L'intitulé français reste
   * celui du formulaire officiel — il ne se traduit pas — et l'anglais
   * l'accompagne, comme dans le PDF.
   */
  labelEn?: string;
  note?: number | string;
  style: "total" | "subtotal" | "header" | "line";
  brut?: string;
  amortProv?: string;
  net: string;
  previousNet: string;
  accounts: string[];
}

export interface ComputedStatement {
  code: StatementCode;
  title: string;
  lines: ComputedLine[];
}

export interface ComputedNote {
  number: number | string;
  title: string;
  /** Glose anglaise du titre de la note. */
  titleEn?: string;
  kind: "LEDGER" | "MODULE" | "NARRATIVE";
  /** `labelEn` : les lignes de notes ne sont pas réglementaires, elles sont traduites. */
  rows: Array<{ label: string; labelEn?: string; code?: string; amount: string; previous: string }>;
  total: string;
  previousTotal: string;
  reconciles?: { statement: StatementCode; code: string; expected: string; ok: boolean };
  outline?: string[];
  status: "COMPUTED" | "DRAFT_REQUIRED";
}

export interface Control {
  id: string;
  label: string;
  severity: "BLOCKING" | "WARNING";
  ok: boolean;
  detail: string;
  expected?: string;
  actual?: string;
  /** Libellé et détail anglais, rédigés avec le contrôle (il porte des montants interpolés). */
  labelEn?: string;
  detailEn?: string;
}

export interface StatementsOutput {
  templateId: string;
  templateVersion: string;
  system: "NORMAL" | "SMT";
  currency: string;
  fiscalYearCode: string;
  statements: Record<StatementCode, ComputedStatement>;
  notes: ComputedNote[];
  controls: Control[];
  publishable: boolean;
  orphanAccounts: string[];
}

export interface PackSummary {
  code: string;
  name: string;
  version: string;
  status: string;
  currency: string;
}

export interface CountryPack {
  code: string;
  name: string;
  version: string;
  status: string;
  reviewed_by?: string;
  identity: {
    currency: string;
    languages: string[];
    tax_ids: Array<{ code: string; label: string; required?: boolean }>;
    accounting_systems: string[];
    tax_authority?: string;
    social_security_body?: string;
  };
  vat?: { rates?: Array<{ code: string; label: string; rate: string | number }> };
}

export interface Company {
  id: string;
  name: string;
  organizationId?: string;
  organizationName?: string;
  countryCode?: string;
  currency?: string;
}

export const JOURNAL_CODES = ["AC", "VT", "BQ", "CA", "PA", "OD", "AN"] as const;
export type JournalCode = (typeof JOURNAL_CODES)[number];
