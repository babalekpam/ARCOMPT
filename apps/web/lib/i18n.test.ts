// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { createTranslator, formatDate, interpolate, isLocale, missingKeys, translate } from "./i18n";

describe("i18n", () => {
  it("traduit en français par défaut et en anglais", () => {
    expect(translate("fr", "nav.entries")).toBe("Écritures");
    expect(translate("en", "nav.entries")).toBe("Entries");
  });

  it("interpole les paramètres et laisse les inconnus visibles", () => {
    expect(interpolate("Bonjour {name}, {n} fois", { name: "Awa", n: 3 })).toBe("Bonjour Awa, 3 fois");
    expect(interpolate("{missing}", {})).toBe("{missing}");
    expect(translate("fr", "dashboard.subtitle", { fy: "2025" })).toContain("2025");
  });

  it("se replie sur le français puis sur la clé", () => {
    expect(translate("en", "clé.inexistante")).toBe("clé.inexistante");
    const t = createTranslator("en");
    expect(t("common.total")).toBe("Total");
  });

  it("garde les dictionnaires FR et EN alignés", () => {
    expect(missingKeys("fr", "en")).toEqual([]);
    expect(missingKeys("en", "fr")).toEqual([]);
  });

  it("reconnaît les langues et date sans ambiguïté dans chaque langue", () => {
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(formatDate("fr", "2025-03-15")).toBe("15/03/2025");
    expect(formatDate("en", "2025-03-15")).toBe("15 Mar 2025");
    expect(formatDate("en", "2025-12-01")).toBe("1 Dec 2025");
    expect(formatDate("fr", null)).toBe("");
  });
});
