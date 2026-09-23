// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Money } from "./money.js";

export type Id = string; // UUID

export type AccountingSystem = "NORMAL" | "SMT";

export type AccountClass = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type AccountNature = "ACTIF" | "PASSIF" | "CHARGE" | "PRODUIT" | "MIXTE" | "ENGAGEMENT";

export interface Account {
  id: Id;
  tenantId: Id;
  /** Numéro SYSCOHADA (ex. "411", "4111", "6041"). */
  number: string;
  label: string;
  class: AccountClass;
  nature: AccountNature;
  /** Un compte lettrable (tiers) exige un partenaire sur chaque ligne. */
  lettrable: boolean;
  /** Seuls les comptes de dernier niveau reçoivent des écritures. */
  postable: boolean;
  active: boolean;
}

export type JournalType = "ACHATS" | "VENTES" | "BANQUE" | "CAISSE" | "PAIE" | "OD" | "AN";

export interface Journal {
  id: Id;
  tenantId: Id;
  code: string; // "AC", "VT", "BQ", "CA", "PA", "OD", "AN"
  label: string;
  type: JournalType;
}

export type PeriodStatus = "OPEN" | "CLOSED" | "LOCKED";

export interface FiscalYear {
  id: Id;
  tenantId: Id;
  code: string; // "2025"
  startDate: string; // ISO date
  endDate: string;
  status: PeriodStatus;
}

export interface Period {
  id: Id;
  tenantId: Id;
  fiscalYearId: Id;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
}

export type EntryStatus = "DRAFT" | "VALIDATED";

export type EntrySource = "MANUAL" | "INVOICE" | "PURCHASE" | "BANK" | "PAYROLL" | "TAX" | "AI" | "IMPORT" | "REVERSAL" | "CLOSING";

export interface JournalLineInput {
  accountNumber: string;
  debit?: Money | string;
  credit?: Money | string;
  partnerId?: Id;
  label?: string;
  /**
   * Devise de la ligne. Absente, la ligne est dans la devise du dossier.
   * Différente, `rate` est obligatoire — à défaut le moteur le cherche dans la
   * table des taux ; s'il n'en trouve aucun, l'écriture est refusée.
   */
  currency?: string;
  /** Taux tel que : montant en `currency` × rate = montant dans la devise du dossier. */
  rate?: string;
  /** Provenance du taux saisi ('MANUAL' par défaut lorsqu'il vient de la pièce). */
  rateSource?: string;
  analyticCode?: string;
  vatCode?: string;
}

export interface JournalEntryInput {
  journalCode: string;
  date: string; // ISO date
  reference?: string; // numéro de pièce
  label: string;
  source: EntrySource;
  lines: JournalLineInput[];
  /** Identifiant client (offline) pour l'idempotence. */
  clientId?: Id;
}

export interface JournalLine {
  id: Id;
  entryId: Id;
  lineNo: number;
  accountId: Id;
  accountNumber: string;
  partnerId: Id | null;
  label: string;
  /** Montant d'origine, dans `currency` : ce que dit la pièce. */
  debit: Money;
  credit: Money;
  currency: string;
  /** Null lorsque la ligne est déjà dans la devise du dossier. */
  rate: string | null;
  /** Provenance du taux appliqué ('FIXED', 'BCEAO', 'MANUAL'…), null sans conversion. */
  rateSource: string | null;
  /**
   * Montant converti dans la devise du dossier : ce qui entre dans l'équilibre,
   * les soldes et les états. Conservé à côté de l'origine, jamais à sa place.
   */
  debitBase: Money;
  creditBase: Money;
  analyticCode: string | null;
  vatCode: string | null;
}

export interface JournalEntry {
  id: Id;
  tenantId: Id;
  journalId: Id;
  journalCode: string;
  periodId: Id;
  fiscalYearId: Id;
  /** Numéro continu par journal, attribué à la validation. */
  number: number | null;
  date: string;
  reference: string | null;
  label: string;
  status: EntryStatus;
  source: EntrySource;
  /** Écriture contrepassée par celle-ci (si contrepassation). */
  reversesEntryId: Id | null;
  /** Écriture qui contrepasse celle-ci. */
  reversedByEntryId: Id | null;
  prevHash: string | null;
  hash: string | null;
  createdBy: Id;
  createdAt: string;
  validatedBy: Id | null;
  validatedAt: string | null;
  lines: JournalLine[];
}

export interface AccountBalance {
  accountNumber: string;
  label: string;
  class: AccountClass;
  debit: Money;
  credit: Money;
}

export interface TrialBalance {
  tenantId: Id;
  /** Devise de tenue du dossier : tous les montants ci-dessous y sont exprimés. */
  currency: string;
  fiscalYearCode: string;
  from: string;
  to: string;
  rows: AccountBalance[];
  totalDebit: Money;
  totalCredit: Money;
}

export interface Actor {
  userId: Id;
  tenantId: Id;
}

/**
 * Position en devise étrangère d'un compte : montant d'origine et contrevaleur
 * historique (celle qui figure dans les soldes). Sert à la retranslation de fin
 * de période, qui compare la contrevaleur historique au cours de clôture.
 */
export interface ForeignPosition {
  accountNumber: string;
  accountLabel: string;
  class: AccountClass;
  partnerId: Id | null;
  currency: string;
  /** Cumuls dans la devise d'origine. */
  foreignDebit: Money;
  foreignCredit: Money;
  /** Cumuls convertis aux taux historiques (ceux portés par les lignes). */
  baseDebit: Money;
  baseCredit: Money;
}
