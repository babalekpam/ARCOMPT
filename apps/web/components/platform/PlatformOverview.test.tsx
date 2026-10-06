import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformOverview } from "./PlatformOverview";
import type { PlatformOverview as Overview } from "@/lib/platform-overview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const overview: Overview = {
  totals: { organizations: 2, companies: 1, users: 3, activeUsers: 2, suspendedUsers: 1 },
  organizations: [
    { id: "org-empty", name: "Cabinet sans dossier", kind: "FIRM", plan: "TRIAL", users: 1, activeUsers: 1, suspendedUsers: 0, companies: [] },
    { id: "org-company", name: "Atelier Diarra", kind: "COMPANY", plan: "PRO", users: 2, activeUsers: 1, suspendedUsers: 1,
      companies: [{ id: "company-1", name: "Atelier Dakar", countryCode: "SN" }] },
  ],
};
describe("platform overview rendering", () => {
  it("renders actual totals, zero-company organizations and the existing selection action", () => {
    const html = renderToStaticMarkup(<PlatformOverview overview={overview} />);
    expect(html).toContain("Cabinet sans dossier");
    expect(html).toContain("Aucun dossier comptable dans cette organisation.");
    expect(html).toContain("Utilisateurs suspendus");
    expect(html).toContain("Atelier Dakar");
    expect(html).toContain("Ouvrir");
    expect(html).toContain("Offre");
    expect(html).not.toContain("revenue");
  });
  it("renders a composed empty state rather than inventing data", () => {
    const html = renderToStaticMarkup(<PlatformOverview overview={{ totals: { organizations: 0, companies: 0, users: 0, activeUsers: 0, suspendedUsers: 0 }, organizations: [] }} />);
    expect(html).toContain("Aucune organisation cliente");
    expect(html).not.toContain("Ouvrir");
  });
});
