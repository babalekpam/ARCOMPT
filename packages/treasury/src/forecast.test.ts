import { describe, expect, it } from "vitest";
import { addDays, forecast13Weeks, recurringDates } from "./forecast.js";

describe("recurringDates", () => {
  it("mensuel : borne le jour au dernier jour du mois", () => {
    expect(recurringDates({ label: "Loyer", amount: "1", direction: "OUT", frequency: "MONTHLY", dayOfMonth: 31 }, "2025-01-15", "2025-04-30")).toEqual(["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30"]);
  });
  it("hebdomadaire : premier jour de semaine voulu à partir du début, et bornes start/end", () => {
    expect(recurringDates({ label: "x", amount: "1", direction: "IN", frequency: "WEEKLY", weekday: 5 }, "2025-09-15", "2025-10-05")).toEqual(["2025-09-19", "2025-09-26", "2025-10-03"]);
    expect(recurringDates({ label: "x", amount: "1", direction: "IN", frequency: "WEEKLY", weekday: 5, startDate: "2025-09-25", endDate: "2025-09-30" }, "2025-09-15", "2025-10-05")).toEqual(["2025-09-26"]);
  });
});

describe("forecast13Weeks", () => {
  it("produit 13 tranches enchaînées : clôture = ouverture + entrées − sorties", () => {
    const f = forecast13Weeks("2025-09-15", {
      openingBalance: "1000000",
      receivables: [
        { dueDate: "2025-09-20", amount: "500000", label: "FAC-1" },
        { dueDate: "2025-09-01", amount: "200000", label: "FAC-0 en retard" },
        { dueDate: "2026-01-15", amount: "999999", label: "trop loin" },
      ],
      payables: [{ dueDate: "2025-09-30", amount: "300000", label: "FF-1" }],
      recurring: [
        { label: "Loyer", amount: "400000", direction: "OUT", frequency: "MONTHLY", dayOfMonth: 1 },
        { label: "Paie", amount: "1500000", direction: "OUT", frequency: "MONTHLY", dayOfMonth: 28 },
      ],
    });
    expect(f.weeks).toHaveLength(13);
    expect(f.asOf).toBe("2025-09-15");
    expect(f.horizonEnd).toBe(addDays("2025-09-15", 90));
    expect(f.weeks[0]).toMatchObject({ index: 1, from: "2025-09-15", to: "2025-09-21", opening: "1000000.0000", inflows: "700000.0000", outflows: "0.0000", closing: "1700000.0000" });
    expect(f.weeks[0]!.items.find((i) => i.label === "FAC-0 en retard")).toMatchObject({ overdue: true, date: "2025-09-15" });
    // Semaine 2 : 22–28 sept. → paie du 28.
    expect(f.weeks[1]).toMatchObject({ inflows: "0.0000", outflows: "1500000.0000", closing: "200000.0000" });
    // Semaine 3 : 29 sept.–5 oct. → FF-1 le 30 et loyer le 1er.
    expect(f.weeks[2]).toMatchObject({ outflows: "700000.0000", closing: "-500000.0000" });
    for (let i = 1; i < f.weeks.length; i++) expect(f.weeks[i]!.opening).toBe(f.weeks[i - 1]!.closing);
    expect(f.firstWeekBelowMinimum).toBe(3);
    expect(f.beyondHorizon).toEqual({ inflows: "999999.0000", outflows: "0.0000" });
    expect(f.lowestWeek).toBeGreaterThanOrEqual(3);
  });

  it("horizon paramétrable et seuil minimal", () => {
    const f = forecast13Weeks("2025-09-15", { openingBalance: "100", weeks: 4, minimumBalance: "50", payables: [{ dueDate: "2025-10-01", amount: "60" }] });
    expect(f.weeks).toHaveLength(4);
    expect(f.firstWeekBelowMinimum).toBe(3);
    expect(f.lowestBalance).toBe("40.0000");
    const calm = forecast13Weeks("2025-09-15", { openingBalance: "100", weeks: 2 });
    expect(calm.firstWeekBelowMinimum).toBeNull();
    expect(calm.weeks.map((w) => w.closing)).toEqual(["100.0000", "100.0000"]);
  });
});
