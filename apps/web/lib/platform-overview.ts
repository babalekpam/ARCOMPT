import type { Company } from "@/lib/types";

/** Read-only snapshot from the verified, audited /platform/overview endpoint.
 * Users are app_user records owned by customer organizations, not memberships
 * or Clerk sessions. Active means suspended_at IS NULL, not recently online.
 */
export interface PlatformOverview {
  totals: {
    organizations: number;
    companies: number;
    users: number;
    activeUsers: number;
    suspendedUsers: number;
  };
  organizations: PlatformOrganization[];
}

export interface PlatformOrganization {
  id: string;
  name: string;
  kind: string;
  plan: string;
  users: number;
  activeUsers: number;
  suspendedUsers: number;
  companies: Company[];
}

export function filterPlatformOrganizations(organizations: PlatformOrganization[], query: string): PlatformOrganization[] {
  const q = query.trim().toLocaleLowerCase("fr");
  if (!q) return organizations;
  const matches = (values: (string | undefined)[]) => values.some((v) => v?.toLocaleLowerCase("fr").includes(q));
  return organizations.flatMap((org) => {
    if (matches([org.name, org.id, org.kind, org.plan])) return [org];
    const companies = org.companies.filter((company) => matches([company.name, company.id, company.countryCode]));
    return companies.length ? [{ ...org, companies }] : [];
  });
}
