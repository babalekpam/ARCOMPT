// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/** Aides pures du module immobilisations (testables sans React ni réseau). */
// Import relatif : le projet vitest « web » ne résout pas l'alias `@/` à l'exécution.
import { addAmounts, subAmounts } from "../../lib/money";
import type { AssetNoteRow, DepreciationRow, FixedAsset } from "./types";

/**
 * Amortissements cumulés d'une immobilisation : reprise antérieure + dotations
 * enregistrées (même règle que le service à la cession).
 */
export function cumulativeDepreciation(asset: Pick<FixedAsset, "priorDepreciation">, posted: Pick<DepreciationRow, "dotation">[]): string {
  return addAmounts(asset.priorDepreciation, ...posted.map((r) => r.dotation));
}

export function netBookValue(asset: Pick<FixedAsset, "cost" | "priorDepreciation">, posted: Pick<DepreciationRow, "dotation">[]): string {
  return subAmounts(asset.cost, cumulativeDepreciation(asset, posted));
}

export interface AssetListRow {
  asset: FixedAsset;
  cumulative: string;
  net: string;
}

/** Totaux d'une liste (brut, amortissements, VNC), en chaînes canoniques. */
export function listTotals(rows: AssetListRow[]): { cost: string; cumulative: string; net: string } {
  return {
    cost: addAmounts("0", ...rows.map((r) => r.asset.cost)),
    cumulative: addAmounts("0", ...rows.map((r) => r.cumulative)),
    net: addAmounts("0", ...rows.map((r) => r.net)),
  };
}

/** Colonnes numériques d'une ligne de note 3A/3C (ordre d'affichage). */
export const NOTE_COLUMNS = ["grossOpening", "acquisitions", "disposals", "grossClosing", "depreciationOpening", "dotations", "reversals", "depreciationClosing", "netClosing"] as const satisfies ReadonlyArray<keyof AssetNoteRow>;

/** Regroupe les lignes d'une note par groupe (ordre d'apparition conservé). */
export function groupNoteRows(rows: AssetNoteRow[]): Array<{ group: string; rows: AssetNoteRow[] }> {
  const out: Array<{ group: string; rows: AssetNoteRow[] }> = [];
  for (const r of rows) {
    const g = out.find((x) => x.group === r.group);
    if (g) g.rows.push(r);
    else out.push({ group: r.group, rows: [r] });
  }
  return out;
}

export const ACCOUNT_RE = /^[1-9]\d{1,12}$/;
export const DEFAULT_DEPRECIATION_MONTHS: Record<string, number> = { CORPORELLE: 60, INCORPORELLE: 36, FINANCIERE: 0 };
