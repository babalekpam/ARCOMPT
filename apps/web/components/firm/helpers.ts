/**
 * Aides pures du portail cabinets : exercice par défaut d'un nouveau dossier,
 * mois courant, rôle de l'utilisateur, urgence d'une ligne du tableau de bord,
 * résumé d'une proposition brute de la file multi-dossiers.
 */
import type { BadgeTone } from "@/components/ui/Badge";
import type { CompanyMember, DashboardRow, MemberRole } from "./types";

export const FIRM_TABS = ["overview", "members", "review", "requests", "filings", "billing", "settings"] as const;
export type FirmTab = (typeof FIRM_TABS)[number];
export const FIRM_TAB_HREF: Record<FirmTab, string> = {
  overview: "/firm",
  members: "/firm/members",
  review: "/firm/review",
  requests: "/firm/requests",
  filings: "/firm/filings",
  billing: "/firm/billing",
  settings: "/firm/settings",
};

/** Exercice civil de l'année de `today` (AAAA-MM-JJ) : code AAAA, du 1er janvier au 31 décembre. */
export function defaultFiscalYear(today: string): { code: string; startDate: string; endDate: string } {
  const year = today.slice(0, 4);
  return { code: year, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

/** Mois AAAA-MM d'une date ISO. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function isMonth(v: unknown): v is string {
  return typeof v === "string" && MONTH_RE.test(v);
}

/**
 * Rôle de l'utilisateur courant d'après les appartenances : OWNER si
 * propriétaire d'au moins un dossier (les droits OWNER sont de niveau
 * organisation), sinon le rôle sur le dossier courant, sinon le premier trouvé.
 * Null si l'utilisateur n'apparaît pas (mode dev, jeton sans identifiant).
 */
export function resolveMyRole(members: CompanyMember[], userId: string, tenantId: string | null): MemberRole | null {
  const mine = members.filter((m) => m.userId === userId);
  if (mine.length === 0) return null;
  if (mine.some((m) => m.role === "OWNER")) return "OWNER";
  return mine.find((m) => m.companyId === tenantId)?.role ?? mine[0]!.role;
}

/** Les actions réservées au propriétaire sont montrées quand le rôle est OWNER ou inconnu (l'API tranche). */
export function canActAsOwner(role: MemberRole | null): boolean {
  return role === null || role === "OWNER";
}

/** Urgence d'un dossier : danger si anomalies ou échéance ≤ 7 j, avertissement si travail en attente, sinon ok. */
export function dashboardUrgency(row: Pick<DashboardRow, "anomalies" | "draftCount" | "pendingProposals" | "missingDocuments" | "nextDeadlines">): BadgeTone {
  const soon = row.nextDeadlines.some((d) => d.daysLeft <= 7);
  if (row.anomalies > 0 || soon) return "danger";
  if (row.draftCount > 0 || (row.pendingProposals ?? 0) > 0 || row.missingDocuments > 0) return "warning";
  return "success";
}

/** Regroupe les membres par dossier, dans l'ordre d'apparition. */
export function groupMembersByCompany(members: CompanyMember[]): Array<{ companyId: string; companyName: string; members: CompanyMember[] }> {
  const map = new Map<string, { companyId: string; companyName: string; members: CompanyMember[] }>();
  for (const m of members) {
    const g = map.get(m.companyId) ?? { companyId: m.companyId, companyName: m.companyName, members: [] };
    g.members.push(m);
    map.set(m.companyId, g);
  }
  return [...map.values()];
}

export interface ProposalSummary {
  id: string;
  label: string;
  route: string | null;
  confidence: number | null;
  createdAt: string | null;
  documentId: string | null;
}

/** Une proposition brute de /org/review-queue (jsonb, forme non garantie) → résumé affichable. */
export function summarizeProposal(raw: Record<string, unknown>): ProposalSummary {
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const proposal = (raw.proposal && typeof raw.proposal === "object" ? raw.proposal : {}) as Record<string, unknown>;
  const id = str(raw.id) ?? "?";
  return {
    id,
    label: str(proposal.label) ?? str(raw.label) ?? id,
    route: str(raw.route),
    confidence: num(raw.confidence) ?? num(proposal.confidence),
    createdAt: str(raw.createdAt) ?? str(raw.created_at),
    documentId: str(raw.documentId) ?? str(raw.document_id),
  };
}

/** Statut de dépôt → tonalité. */
export function filingTone(status: string): BadgeTone {
  return status === "ACKNOWLEDGED" ? "success" : status === "FILED" ? "info" : "warning";
}

/** Part d'utilisation d'un quota (0..100), null sans quota. */
export function quotaPercent(used: number, quota: number | null): number | null {
  if (quota === null || quota <= 0) return null;
  return Math.min(100, Math.round((used / quota) * 100));
}
