import type {
  Account,
  AccountBalance,
  Actor,
  FiscalYear,
  Id,
  Journal,
  JournalEntry,
  Period,
} from "./types.js";

/**
 * Port de persistance du moteur comptable. Deux adaptateurs :
 *  - MemoryStore (tests, simulation, calculs hors ligne)
 *  - PostgresStore (production ; les invariants sont aussi garantis en base)
 *
 * Toute opération est scoped par tenant : l'adaptateur ne renvoie jamais
 * une donnée d'un autre dossier.
 */
export interface LedgerStore {
  getAccountByNumber(tenantId: Id, number: string): Promise<Account | null>;
  listAccounts(tenantId: Id): Promise<Account[]>;
  getJournalByCode(tenantId: Id, code: string): Promise<Journal | null>;
  listJournals(tenantId: Id): Promise<Journal[]>;
  findPeriodForDate(tenantId: Id, date: string): Promise<{ period: Period; fiscalYear: FiscalYear } | null>;
  listFiscalYears(tenantId: Id): Promise<FiscalYear[]>;
  getFiscalYearByCode(tenantId: Id, code: string): Promise<FiscalYear | null>;

  getEntry(tenantId: Id, entryId: Id): Promise<JournalEntry | null>;
  findEntryByClientId(tenantId: Id, clientId: Id): Promise<JournalEntry | null>;
  insertDraft(entry: JournalEntry, clientId?: Id): Promise<JournalEntry>;
  /** Supprime un brouillon (jamais une écriture validée). */
  deleteDraft(tenantId: Id, entryId: Id): Promise<void>;
  /** Dernier hash et numéro du journal (écritures validées uniquement). */
  lastValidated(tenantId: Id, journalId: Id): Promise<{ number: number; hash: string } | null>;
  /**
   * Passe un brouillon en VALIDATED de manière atomique : numéro, hash,
   * horodatage, mise à jour des soldes. Doit échouer si l'écriture n'est plus
   * un brouillon ou si la période est verrouillée.
   */
  markValidated(
    entry: JournalEntry,
    fields: { number: number; prevHash: string | null; hash: string; validatedBy: Id; validatedAt: string },
  ): Promise<JournalEntry>;
  linkReversal(tenantId: Id, originalId: Id, reversalId: Id): Promise<void>;

  /** Soldes cumulés par compte sur un intervalle de dates (écritures validées). */
  accountBalances(tenantId: Id, from: string, to: string): Promise<AccountBalance[]>;
  /** Écritures validées d'un journal dans l'ordre de numérotation (audit, vérification de chaîne). */
  listValidatedEntries(tenantId: Id, journalId: Id): Promise<JournalEntry[]>;
  /** Écritures validées d'un exercice (grand livre), filtrables par compte ou préfixe de compte, triées par date puis numéro. */
  listEntries(tenantId: Id, opts: { fiscalYearCode: string; accountNumber?: string }): Promise<JournalEntry[]>;

  setPeriodStatus(tenantId: Id, periodId: Id, status: Period["status"], actor: Actor): Promise<void>;

  /** Ouvre un exercice, ses périodes mensuelles et les journaux par défaut. */
  createFiscalYear(tenantId: Id, fy: Omit<FiscalYear, "id" | "tenantId" | "status">): Promise<FiscalYear>;

  appendAudit(event: AuditEvent): Promise<void>;
}

export interface AuditEvent {
  tenantId: Id;
  userId: Id;
  action: string;
  entity: string;
  entityId: Id;
  before?: unknown;
  after?: unknown;
  at: string;
}
