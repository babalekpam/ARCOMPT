// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { cumulativeDepreciation, groupNoteRows, listTotals, netBookValue } from "./helpers";
import type { AssetNoteRow, FixedAsset } from "./types";

const asset = { cost: "1000.0000", priorDepreciation: "100.0000" } as FixedAsset;
const posted = [{ dotation: "200.0000" }, { dotation: "150.5000" }];

describe("assets helpers", () => {
  it("cumule reprise antérieure et dotations enregistrées", () => {
    expect(cumulativeDepreciation(asset, posted)).toBe("450.5000");
    expect(cumulativeDepreciation(asset, [])).toBe("100.0000");
  });

  it("calcule la valeur nette comptable", () => {
    expect(netBookValue(asset, posted)).toBe("549.5000");
  });

  it("totalise une liste", () => {
    const rows = [
      { asset: { ...asset, cost: "1000.0000" }, cumulative: "450.5000", net: "549.5000" },
      { asset: { ...asset, cost: "500.0000" }, cumulative: "0.0000", net: "500.0000" },
    ];
    expect(listTotals(rows)).toEqual({ cost: "1500.0000", cumulative: "450.5000", net: "1049.5000" });
    expect(listTotals([])).toEqual({ cost: "0.0000", cumulative: "0.0000", net: "0.0000" });
  });

  it("regroupe les lignes de note par groupe en conservant l'ordre", () => {
    const row = (group: string, label: string) => ({ group, label }) as AssetNoteRow;
    expect(groupNoteRows([row("A", "1"), row("B", "2"), row("A", "3")]).map((g) => `${g.group}:${g.rows.length}`)).toEqual(["A:2", "B:1"]);
  });
});
