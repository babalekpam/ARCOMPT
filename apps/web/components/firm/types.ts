/**
 * Types des réponses de l'API portail cabinets (/v1/portal/…). Copiés du
 * paquet @arcompt/portal : les montants sont des chaînes décimales.
 */
export type OrganizationKind = "FIRM" | "COMPANY" | "GROUP";
export type MemberRole = "OWNER" | "ACCOUNTANT" | "CASHIER" | "AUDITOR" | "REVIEWER";
export const MEMBER_ROLES: readonly MemberRole[] = ["OWNER", "ACCOUNTANT", "CASHIER", "AUDITOR", "REVIEWER"];
export type MessageChannel = "WHATSAPP" | "EMAIL";
export type FilingKind = "DSF" | "VAT" | "SOCIAL";
export const FILING_KINDS: readonly FilingKind[] = ["DSF", "VAT", "SOCIAL"];
export type FilingFormat = "XLSX" | "XML" | "PDF" | "CSV" | "MANUAL";
export const FILING_FORMATS: readonly FilingFormat[] = ["XLSX", "XML", "PDF", "CSV", "MANUAL"];
export type FilingStatus = "PREPARED" | "FILED" | "ACKNOWLEDGED";

export interface Organization {
  id: string;
  name: string;
  kind: OrganizationKind;
  plan: string;
  mfaRequired: boolean;
  createdAt: string;
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

export interface InviteResult {
  invitation: Invitation;
  token: string;
}

export interface AcceptResult {
  userId: string;
  organizationId: string;
  role: MemberRole;
  companyIds: string[];
}

export interface CompanyMember {
  companyId: string;
  companyName: string;
  userId: string;
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
  pendingProposals: number | null;
  openPeriods: number;
  fiscalYear: { id: string; code: string; status: string; startDate: string; endDate: string } | null;
  workflowState: string | null;
  anomalies: number;
  unresolvedComments: number;
  missingDocuments: number;
  nextDeadlines: Deadline[];
}

export interface OrgReviewQueue {
  available: boolean;
  totalPending: number;
  companies: Array<{ companyId: string; name: string; pending: number; proposals: Record<string, unknown>[] }>;
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

export interface UsageReport {
  tenantId: string;
  month: string;
  aiCalls: number;
  documents: number;
  whatsappMessages: number;
  quotas: { aiCalls: number | null; documents: number | null; whatsappMessages: number | null };
  exceeded: { aiCalls: boolean; documents: boolean; whatsappMessages: boolean };
}

export interface AdminAccessRecord {
  id: number;
  tenantId: string;
  adminUserId: string;
  reason: string;
  breakGlassRequestId: string | null;
  notifiedCount: number;
  notifiedAt: string | null;
  accessedAt: string;
}

export interface BreakGlassRequest {
  id: string;
  tenantId: string;
  requesterId: string;
  approverId: string | null;
  reason: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string;
  active: boolean;
}

export interface EntitlementReviewItem extends CompanyMember {
  lastActiveAt: string | null;
  suspendedAt: string | null;
  reasons: string[];
}

export interface AppUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  keycloakSub: string | null;
  locale: string;
}

export interface OrganizationInvoice {
  organizationId: string;
  month: string;
  planCode: string;
  currency: string;
  activeDossiers: number;
  dossiers: number;
  mode: string;
  unitPrice: string | null;
  total: string;
  lines: Array<{ from: number; to: number; count: number; unitPrice: string; amount: string }>;
}
