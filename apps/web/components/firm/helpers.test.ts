// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { canActAsOwner, dashboardUrgency, defaultFiscalYear, filingTone, groupMembersByCompany, isMonth, monthOf, quotaPercent, resolveMyRole, summarizeProposal } from "./helpers";
import type { CompanyMember } from "./types";

const member = (companyId: string, userId: string, role: CompanyMember["role"]): CompanyMember => ({ companyId, companyName: `Dossier ${companyId}`, userId, reference: null, email: null, displayName: null, role });

describe("firm helpers", () => {
  it("propose un exercice civil et le mois courant", () => {
    expect(defaultFiscalYear("2025-09-19")).toEqual({ code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
    expect(monthOf("2025-09-19T10:00:00Z")).toBe("2025-09");
    expect(isMonth("2025-13")).toBe(false);
    expect(isMonth("2025-09")).toBe(true);
  });

  it("résout le rôle de l'utilisateur et les droits propriétaire", () => {
    const members = [member("c1", "u1", "ACCOUNTANT"), member("c2", "u1", "OWNER"), member("c1", "u2", "REVIEWER")];
    expect(resolveMyRole(members, "u1", "c1")).toBe("OWNER");
    expect(resolveMyRole(members, "u2", "c1")).toBe("REVIEWER");
    expect(resolveMyRole(members, "u2", "c9")).toBe("REVIEWER");
    expect(resolveMyRole(members, "u3", "c1")).toBeNull();
    expect(canActAsOwner(null)).toBe(true);
    expect(canActAsOwner("OWNER")).toBe(true);
    expect(canActAsOwner("ACCOUNTANT")).toBe(false);
  });

  it("qualifie l'urgence d'une ligne du tableau de bord", () => {
    const base = { anomalies: 0, draftCount: 0, pendingProposals: 0, missingDocuments: 0, nextDeadlines: [] };
    expect(dashboardUrgency(base)).toBe("success");
    expect(dashboardUrgency({ ...base, draftCount: 2 })).toBe("warning");
    expect(dashboardUrgency({ ...base, pendingProposals: null, missingDocuments: 1 })).toBe("warning");
    expect(dashboardUrgency({ ...base, anomalies: 1 })).toBe("danger");
    expect(dashboardUrgency({ ...base, nextDeadlines: [{ id: "d", label: "TVA", frequency: "MONTHLY", dueDate: "2025-01-15", daysLeft: 3 }] })).toBe("danger");
  });

  it("regroupe les membres par dossier et résume une proposition brute", () => {
    const groups = groupMembersByCompany([member("c1", "u1", "OWNER"), member("c2", "u1", "OWNER"), member("c1", "u2", "CASHIER")]);
    expect(groups.map((g) => [g.companyId, g.members.length])).toEqual([["c1", 2], ["c2", 1]]);
    expect(summarizeProposal({ id: "p1", route: "REVIEW_QUEUE", confidence: "0.7", created_at: "2025-01-01", proposal: { label: "Achat carburant" } })).toEqual({
      id: "p1",
      label: "Achat carburant",
      route: "REVIEW_QUEUE",
      confidence: 0.7,
      createdAt: "2025-01-01",
      documentId: null,
    });
    expect(summarizeProposal({}).label).toBe("?");
  });

  it("tonalité des dépôts et pourcentage de quota", () => {
    expect(filingTone("PREPARED")).toBe("warning");
    expect(filingTone("ACKNOWLEDGED")).toBe("success");
    expect(quotaPercent(50, 200)).toBe(25);
    expect(quotaPercent(300, 200)).toBe(100);
    expect(quotaPercent(3, null)).toBeNull();
  });
});
