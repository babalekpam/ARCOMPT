// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Money } from "@arcompt/ledger";

export type Id = string; // UUID

export type TreasuryAccountKind = "BANK" | "CASH" | "MOBILE_MONEY";

/** Compte de trésorerie : banque (521xx), caisse (571…), mobile money (5381). */
export interface TreasuryAccount {
  id: Id;
  tenantId: Id;
  kind: TreasuryAccountKind;
  label: string;
  /** Numéro du compte dans le plan comptable (classe 5). */
  accountNumber: string;
  currency: string;
  bankName: string | null;
  iban: string | null;
  mmOperator: string | null;
  mmPhone: string | null;
  active: boolean;
  createdAt: string;
}

export interface TreasuryAccountInput {
  kind: TreasuryAccountKind;
  label: string;
  accountNumber: string;
  currency: string;
  bankName?: string;
  iban?: string;
  mmOperator?: string;
  mmPhone?: string;
  active?: boolean;
}

export type StatementSource = "CSV" | "PDF" | "SMS" | "API";

export interface BankStatement {
  id: Id;
  tenantId: Id;
  treasuryAccountId: Id;
  periodFrom: string;
  periodTo: string;
  openingBalance: Money | null;
  closingBalance: Money | null;
  source: StatementSource;
  documentId: Id | null;
  hash: string;
  importedBy: Id | null;
  importedAt: string;
}

/**
 * Ligne de relevé normalisée, telle que produite par les parseurs (CSV, SMS)
 * ou fournie directement par l'API. `amount` est signé du point de vue de
 * l'entreprise : positif = encaissement, négatif = décaissement.
 */
export interface StatementRow {
  date: string; // ISO
  valueDate?: string;
  label: string;
  amount: string; // chaîne décimale acceptée par Money.parse
  reference?: string;
  externalId?: string;
}

export type TransactionStatus = "UNMATCHED" | "MATCHED" | "IGNORED";
export type MatchMethod = "RULE" | "AMOUNT_DATE" | "LLM" | "MANUAL";

export interface BankTransaction {
  id: Id;
  tenantId: Id;
  statementId: Id;
  treasuryAccountId: Id;
  date: string;
  valueDate: string | null;
  label: string;
  amount: Money;
  reference: string | null;
  externalId: string | null;
  status: TransactionStatus;
  matchedLineId: Id | null;
  matchConfidence: number | null;
  matchMethod: MatchMethod | null;
  matchedBy: Id | null;
  matchedAt: string | null;
  createdAt: string;
}

export interface BankRule {
  id: Id;
  tenantId: Id;
  treasuryAccountId: Id | null;
  pattern: string;
  isRegex: boolean;
  accountNumber: string;
  partnerId: Id | null;
  label: string | null;
  priority: number;
  active: boolean;
  createdAt: string;
}

export interface BankRuleInput {
  treasuryAccountId?: Id;
  pattern: string;
  isRegex?: boolean;
  accountNumber: string;
  partnerId?: Id;
  label?: string;
  priority?: number;
  active?: boolean;
}

export interface CashCount {
  id: Id;
  tenantId: Id;
  treasuryAccountId: Id;
  countedOn: string;
  countedAmount: Money;
  bookAmount: Money;
  difference: Money;
  note: string | null;
  entryId: Id | null;
  countedBy: Id | null;
  createdAt: string;
}

/** Ligne du grand livre sur le compte de trésorerie, candidate au rapprochement. */
export interface LedgerLineCandidate {
  lineId: Id;
  entryId: Id;
  entryNumber: number | null;
  journalCode: string;
  date: string;
  label: string;
  entryLabel: string;
  reference: string | null;
  /** Signé du point de vue de l'entreprise : débit du compte 5 = encaissement (+). */
  amount: Money;
  partnerId: Id | null;
}
