import { describe, expect, it } from "vitest";
import { filterPlatformOrganizations, type PlatformOrganization } from "./platform-overview";

const organizations: PlatformOrganization[] = [
  { id: "org-1", name: "Cabinet Ndoye", kind: "FIRM", plan: "TRIAL", users: 2, activeUsers: 1, suspendedUsers: 1, companies: [] },
  { id: "org-2", name: "Cabinet Ndoye", kind: "COMPANY", plan: "PRO", users: 1, activeUsers: 1, suspendedUsers: 0,
    companies: [{ id: "company-1", name: "Atelier Diarra", countryCode: "SN" }, { id: "company-2", name: "Maison Soro", countryCode: "CI" }] },
];
describe("read-only organization directory", () => {
  it("keeps empty organizations and does not merge equal organization names", () => {
    expect(filterPlatformOrganizations(organizations, "")).toEqual(organizations);
    expect(filterPlatformOrganizations(organizations, "ndoye")).toHaveLength(2);
    expect(filterPlatformOrganizations(organizations, "org-1")[0].companies).toEqual([]);
  });
  it("searches companies, country codes and real plan/kind fields without changing source counts", () => {
    const result = filterPlatformOrganizations(organizations, " diARRa ");
    expect(result[0].companies.map((c) => c.id)).toEqual(["company-1"]);
    expect(result[0].users).toBe(1);
    expect(filterPlatformOrganizations(organizations, "ci")[0].companies.map((c) => c.id)).toEqual(["company-2"]);
    expect(filterPlatformOrganizations(organizations, "trial")[0].id).toBe("org-1");
    expect(organizations[1].companies).toHaveLength(2);
    expect(filterPlatformOrganizations(organizations, "introuvable")).toEqual([]);
  });
});
