import type { AccountBalance, AccountingSystem, Money } from "@arcompt/ledger";

export type StatementCode = "BILAN_ACTIF" | "BILAN_PASSIF" | "COMPTE_RESULTAT" | "TFT";

/**
 * Définition d'un poste. Les formules sont des listes de termes
 * (voir formula.ts). Un poste calculé (`sum`) additionne d'autres postes.
 */
export interface LineDefinition {
  code: string;
  label: string;
  /** Référence de note annexe. */
  note?: number | string;
  /** Poste de total ou de solde intermédiaire : somme signée d'autres postes. */
  sum?: Array<string | { code: string; sign: 1 | -1 }>;
  /** Bilan actif : brut, amortissements/dépréciations, net = brut − amort. */
  brut?: string[];
  amort_prov?: string[];
  /** Postes à valeur unique (passif, compte de résultat, TFT). */
  formula?: string[];
  /** Mise en forme. */
  style?: "total" | "subtotal" | "header" | "line";
  /** Présent uniquement dans certains systèmes. */
  systems?: AccountingSystem[];
}

export interface StatementTemplate {
  code: StatementCode;
  title: string;
  lines: LineDefinition[];
}

export interface NoteRowDefinition {
  label: string;
  formula?: string[];
  sum?: string[];
  code?: string;
}

export interface NoteDefinition {
  number: number | string;
  title: string;
  kind: "LEDGER" | "MODULE" | "NARRATIVE";
  /** Poste de l'état auquel le total de la note doit être égal. */
  reconciles?: { statement: StatementCode; code: string; column?: "brut" | "amort_prov" | "net" };
  rows?: NoteRowDefinition[];
  /** Pour les notes narratives : trame proposée à l'IA, marquée « à valider ». */
  outline?: string[];
}

export interface TemplateSet {
  id: string; // "syscohada-revise"
  version: string; // "2017.1"
  statements: StatementTemplate[];
  notes: NoteDefinition[];
}

export interface ComputedLine {
  code: string;
  label: string;
  note?: number | string;
  style: NonNullable<LineDefinition["style"]>;
  /** Exercice N. */
  brut?: Money;
  amortProv?: Money;
  net: Money;
  /** Exercice N-1 (net). */
  previousNet: Money;
  accounts: string[];
}

export interface ComputedStatement {
  code: StatementCode;
  title: string;
  lines: ComputedLine[];
  byCode: Record<string, ComputedLine>;
}

export interface ComputedNoteRow {
  label: string;
  code?: string;
  amount: Money;
  previous: Money;
}

export interface ComputedNote {
  number: number | string;
  title: string;
  kind: NoteDefinition["kind"];
  rows: ComputedNoteRow[];
  total: Money;
  previousTotal: Money;
  reconciles?: { statement: StatementCode; code: string; expected: Money; ok: boolean };
  /** Notes narratives : brouillon à produire par l'IA puis à valider. */
  outline?: string[];
  status: "COMPUTED" | "DRAFT_REQUIRED";
}

export type Severity = "BLOCKING" | "WARNING";

export interface Control {
  id: string;
  label: string;
  severity: Severity;
  ok: boolean;
  detail: string;
  expected?: string;
  actual?: string;
}

export interface StatementsInput {
  system: AccountingSystem;
  currency: string;
  fiscalYearCode: string;
  /** Balance de clôture N (totaux débit/crédit par compte de dernier niveau, après à-nouveaux). */
  balance: AccountBalance[];
  /** Balance de clôture N-1 (facultative : sans elle, la colonne N-1 et le TFT sont vides). */
  previousBalance?: AccountBalance[];
  /** Capital social au sens de l'AUSCGIE, pour l'alerte de perte de la moitié du capital. */
  templateVersion?: string;
}

export interface StatementsOutput {
  templateId: string;
  templateVersion: string;
  system: AccountingSystem;
  currency: string;
  fiscalYearCode: string;
  statements: Record<StatementCode, ComputedStatement>;
  notes: ComputedNote[];
  controls: Control[];
  /** Vrai si aucun contrôle bloquant n'échoue. */
  publishable: boolean;
  /** Comptes mouvementés qu'aucun poste ne reprend : à corriger avant publication. */
  orphanAccounts: string[];
}
