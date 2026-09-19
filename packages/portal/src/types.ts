/** Types partagés du portail cabinets. */

export type OrganizationKind = "FIRM" | "COMPANY" | "GROUP";

export type MemberRole = "OWNER" | "ACCOUNTANT" | "CASHIER" | "AUDITOR" | "REVIEWER";

export const MEMBER_ROLES: readonly MemberRole[] = ["OWNER", "ACCOUNTANT", "CASHIER", "AUDITOR", "REVIEWER"];

export type CommentEntityKind = "ENTRY" | "DOCUMENT" | "PROPOSAL" | "PERIOD" | "FISCAL_YEAR";

export type MessageChannel = "WHATSAPP" | "EMAIL";

export type FilingKind = "DSF" | "VAT" | "SOCIAL";

export type FilingFormat = "XLSX" | "XML" | "PDF" | "CSV" | "MANUAL";

export type FilingStatus = "PREPARED" | "FILED" | "ACKNOWLEDGED";

/** Contexte d'une opération de niveau organisation (cabinet). */
export interface OrganizationContext {
  organizationId: string;
  userId?: string;
}

/** Contexte d'une opération de niveau dossier : le tenant vient du jeton. */
export interface TenantContext {
  tenantId: string;
  organizationId?: string;
  userId: string;
}

export interface Organization {
  id: string;
  name: string;
  kind: OrganizationKind;
  plan: string;
  /** Vrai pour un cabinet (toujours) ou si le drapeau est activé. */
  mfaRequired: boolean;
  createdAt: string;
}

export interface AppUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  keycloakSub: string | null;
  locale: string;
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: MemberRole;
  companyIds: string[];
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface CompanyMember {
  companyId: string;
  companyName: string;
  userId: string;
  /** Null si l'utilisateur appartient à une autre organisation (RLS). */
  email: string | null;
  displayName: string | null;
  role: MemberRole;
}

export interface CompanySummary {
  id: string;
  organizationId: string;
  name: string;
  countryCode: string;
  currency: string;
  accountingSystem: "NORMAL" | "SMT";
  packVersion: string;
  taxRegime: string | null;
  createdAt: string;
}

export interface Deadline {
  id: string;
  label: string;
  frequency: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  dueDate: string;
  daysLeft: number;
}

/** Une ligne du tableau de bord multi-dossiers (sortie de portal_dashboard + échéances du pack). */
export interface DashboardRow {
  companyId: string;
  name: string;
  countryCode: string;
  currency: string;
  accountingSystem: "NORMAL" | "SMT";
  packVersion: string;
  lastEntryDate: string | null;
  draftCount: number;
  validatedCount: number;
  /** Null si le module documents (table ai_proposal) n'est pas installé. */
  pendingProposals: number | null;
  openPeriods: number;
  fiscalYear: { id: string; code: string; status: string; startDate: string; endDate: string } | null;
  /** Null si le module clôture (table fiscal_year_workflow) n'est pas installé ou sans workflow. */
  workflowState: string | null;
  anomalies: number;
  unresolvedComments: number;
  missingDocuments: number;
  nextDeadlines: Deadline[];
}

export interface ReviewQueue {
  /** Faux si la table ai_proposal n'existe pas encore : file vide, sans erreur. */
  available: boolean;
  totalPending: number;
  companies: Array<{ companyId: string; name: string; pending: number; proposals: Record<string, unknown>[] }>;
}

export interface Comment {
  id: string;
  tenantId: string;
  entityKind: CommentEntityKind;
  entityId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface MissingDocumentRequest {
  id: string;
  tenantId: string;
  partnerId: string | null;
  entryId: string | null;
  description: string;
  channel: MessageChannel;
  recipient: string;
  requestedBy: string;
  sentAt: string | null;
  receivedDocumentId: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface Filing {
  id: string;
  tenantId: string;
  fiscalYearId: string;
  kind: FilingKind;
  portalName: string;
  format: FilingFormat;
  periodLabel: string | null;
  fileDocumentId: string | null;
  receiptDocumentId: string | null;
  status: FilingStatus;
  preparedBy: string;
  filedAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhiteLabelSettings {
  brandName: string | null;
  logoDocumentId: string | null;
  colours: { primary: string | null; accent: string | null };
  senderName: string | null;
}

export interface UsageCounters {
  tenantId: string;
  month: string;
  aiCalls: number;
  documents: number;
  whatsappMessages: number;
}

export interface UsageQuotas {
  aiCalls: number | null;
  documents: number | null;
  whatsappMessages: number | null;
}

export interface UsageReport extends UsageCounters {
  quotas: UsageQuotas;
  exceeded: { aiCalls: boolean; documents: boolean; whatsappMessages: boolean };
}
