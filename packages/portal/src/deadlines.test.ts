// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { nextDeadlines } from "./deadlines.js";

const pack = {
  calendar: [
    { id: "vat", label: "TVA", frequency: "MONTHLY" as const, due: "15" },
    { id: "is_acompte", label: "Acomptes IS", frequency: "QUARTERLY" as const, due: "15" },
    { id: "dsf", label: "DSF", frequency: "ANNUAL" as const, due: "06-30" },
    { id: "smt", label: "Régime SMT", frequency: "ANNUAL" as const, due: "03-31", applies_to: ["SMT"] },
  ],
};

describe("échéances du pack", () => {
  it("calcule les prochaines occurrences dans l'horizon", () => {
    const out = nextDeadlines(pack, new Date("2025-06-01T10:00:00Z"), 60);
    expect(out.map((d) => `${d.id}:${d.dueDate}`)).toEqual(["vat:2025-06-15", "dsf:2025-06-30", "is_acompte:2025-07-15", "vat:2025-07-15"]);
    expect(out[0]!.daysLeft).toBe(14);
  });

  it("inclut le jour même, passe l'année et respecte applies_to", () => {
    const out = nextDeadlines(pack, new Date("2025-12-15T00:00:00Z"), 120, "SMT");
    expect(out.map((d) => `${d.id}:${d.dueDate}`)).toEqual(["vat:2025-12-15", "is_acompte:2026-01-15", "vat:2026-01-15", "vat:2026-02-15", "vat:2026-03-15", "smt:2026-03-31"]);
    expect(nextDeadlines(pack, new Date("2025-03-01T00:00:00Z"), 40, "NORMAL").some((d) => d.id === "smt")).toBe(false);
  });

  it("borne le jour à la fin du mois", () => {
    const out = nextDeadlines({ calendar: [{ id: "x", label: "x", frequency: "MONTHLY", due: "31" }] }, new Date("2025-02-01T00:00:00Z"), 28);
    expect(out.map((d) => d.dueDate)).toEqual(["2025-02-28"]);
  });
});
