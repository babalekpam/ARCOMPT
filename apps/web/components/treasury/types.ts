/**
 * Types des réponses de l'API trésorerie (/v1/treasury). Copiés du paquet
 * serveur : les montants sont des chaînes canoniques à 4 décimales.
 */
export type TreasuryAccountKind = "BANK" | "CASH" | "MOBILE_MONEY";
export const TREASURY_KINDS: TreasuryAccountKind[] = ["BANK", "CASH", "MOBILE_MONEY"];

export interface TreasuryAccount {
  id: string;
  tenantId: string;
  kind: TreasuryAccountKind;
  label: string;
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
  id: string;
  tenantId: string;
  treasuryAccountId: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: string | null;
  closingBalance: string | null;
  source: StatementSource;
  documentId: string | null;
  hash: string;
  importedBy: string | null;
  importedAt: string;
}

export type TransactionStatus = "UNMATCHED" | "MATCHED" | "IGNORED";
export const TRANSACTION_STATUSES: TransactionStatus[] = ["UNMATCHED", "MATCHED", "IGNORED"];
export type MatchMethod = "RULE" | "AMOUNT_DATE" | "LLM" | "MANUAL";

export interface BankTransaction {
  id: string;
  tenantId: string;
  statementId: string;
  treasuryAccountId: string;
  date: string;
  valueDate: string | null;
  label: string;
  amount: string;
  reference: string | null;
  externalId: string | null;
  status: TransactionStatus;
  matchedLineId: string | null;
  matchConfidence: number | null;
  matchMethod: MatchMethod | null;
  matchedBy: string | null;
  matchedAt: string | null;
  createdAt: string;
}

export interface LedgerLineCandidate {
  lineId: string;
  entryId: string;
  entryNumber: number | null;
  journalCode: string;
  date: string;
  label: string;
  entryLabel: string;
  reference: string | null;
  amount: string;
  partnerId: string | null;
}

export interface CsvParseError {
  line: number;
  message: string;
}

export interface StatementImportResult {
  statement: BankStatement;
  imported: number;
  skippedDuplicates: number;
  parseErrors: CsvParseError[];
  unparsed: string[];
  rowsInClosedPeriods: number;
}

export interface ScoredCandidate {
  lineId: string;
  score: number;
  dateDelta: number;
  labelSimilarity: number;
  unique: boolean;
}

export type MatchReason = "MATCHED" | "NO_CANDIDATE" | "BELOW_THRESHOLD" | "AMBIGUOUS";

export interface MatchDecision {
  transactionId: string;
  candidates: ScoredCandidate[];
  best: ScoredCandidate | null;
  autoMatch: boolean;
  reason: MatchReason;
  method?: MatchMethod;
  confidence?: number;
  suggestedRuleId?: string;
  suggestedAccountNumber?: string;
}

export interface AutoMatchResult {
  matched: number;
  unmatched: number;
  llmConsulted: number;
  decisions: MatchDecision[];
}

export interface OutstandingItem {
  id: string;
  date: string;
  label: string;
  amount: string;
}

export interface CashCountAnomaly {
  cashCountId: string;
  countedOn: string;
  difference: string;
  note: string | null;
}

export interface ReconciliationReport {
  account: TreasuryAccount;
  asOf: string;
  bookBalance: string;
  statementBalance: string | null;
  statementId: string | null;
  reconciledFrom: string | null;
  unbookedTransactions: OutstandingItem[];
  unclearedLines: OutstandingItem[];
  ignoredTransactions: number;
  adjustedBookBalance: string;
  adjustedStatementBalance: string | null;
  difference: string | null;
  balanced: boolean;
  cashCountAnomalies: CashCountAnomaly[];
}

export interface CashCount {
  id: string;
  tenantId: string;
  treasuryAccountId: string;
  countedOn: string;
  countedAmount: string;
  bookAmount: string;
  difference: string;
  note: string | null;
  entryId: string | null;
  countedBy: string | null;
  createdAt: string;
}

export interface CashCountResult {
  count: CashCount;
  entry: { id: string; number: number | null } | null;
  negativeCash: boolean;
  anomaly: boolean;
  warnings: string[];
}

export interface ForecastLine {
  label: string;
  date: string;
  amount: string;
  kind: "RECEIVABLE" | "PAYABLE" | "RECURRING";
  overdue?: boolean;
}

export interface ForecastWeek {
  index: number;
  from: string;
  to: string;
  opening: string;
  inflows: string;
  outflows: string;
  closing: string;
  items: ForecastLine[];
}

export interface Forecast {
  asOf: string;
  horizonEnd: string;
  weeks: ForecastWeek[];
  lowestBalance: string;
  lowestWeek: number;
  firstWeekBelowMinimum: number | null;
  beyondHorizon: { inflows: string; outflows: string };
}

export interface RecurringItemInput {
  label: string;
  amount: string;
  direction: "IN" | "OUT";
  frequency: "WEEKLY" | "MONTHLY";
  dayOfMonth?: number;
  weekday?: number;
  startDate?: string;
  endDate?: string;
}

export interface ForecastBody {
  asOf: string;
  openingBalance?: string;
  accountIds?: string[];
  receivables?: Array<{ dueDate: string; amount: string; label?: string }>;
  payables?: Array<{ dueDate: string; amount: string; label?: string }>;
  recurring?: RecurringItemInput[];
  weeks?: number;
  minimumBalance?: string;
}
