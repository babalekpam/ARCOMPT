// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money, type AccountingSystem } from "@arcompt/ledger";
import { evalFormula, type BalanceIndex } from "./formula.js";
import type { ComputedLine, ComputedNote, ComputedStatement, NoteDefinition, NoteReconciliation, StatementCode } from "./types.js";

/** Colonne d'un poste visée par le rapprochement d'une note. */
function columnOf(line: ComputedLine, column: NoteReconciliation["column"]): Money {
  if (column === "brut") return line.brut ?? line.net;
  if (column === "amort_prov") return line.amortProv ?? Money.zero();
  return line.net;
}

export function computeNotes(
  defs: NoteDefinition[],
  statements: Record<StatementCode, ComputedStatement>,
  current: BalanceIndex,
  previous: BalanceIndex,
  system: AccountingSystem,
): ComputedNote[] {
  const out: ComputedNote[] = [];
  // Système minimal : seules les notes essentielles (règles, clients, fournisseurs, événements postérieurs).
  const smtNotes = new Set([2, 7, 17, 35]);
  for (const def of defs) {
    if (system === "SMT" && !smtNotes.has(Number(def.number))) continue;
    if (def.kind !== "LEDGER" || !def.rows) {
      out.push({
        number: def.number,
        title: def.title,
        kind: def.kind,
        rows: [],
        total: Money.zero(),
        previousTotal: Money.zero(),
        ...(def.outline ? { outline: def.outline } : {}),
        status: "DRAFT_REQUIRED",
      });
      continue;
    }
    const rows = def.rows.map((r) => {
      const cur = r.formula ? evalFormula(r.formula, current, previous) : { amount: Money.zero() };
      const prev = r.formula && previous.size > 0 ? evalFormula(r.formula, previous, new Map()) : { amount: Money.zero() };
      return { label: r.label, ...(r.code ? { code: r.code } : {}), amount: cur.amount, previous: prev.amount };
    });
    const total = rows.reduce((acc, r) => acc.add(r.amount), Money.zero());
    const previousTotal = rows.reduce((acc, r) => acc.add(r.previous), Money.zero());
    let reconciles: ComputedNote["reconciles"];
    if (def.reconciles) {
      // Une note peut viser un poste unique ou la somme de plusieurs postes,
      // éventuellement dans deux états (écart de conversion actif et passif).
      const targets = Array.isArray(def.reconciles) ? def.reconciles : [def.reconciles];
      const lines = targets.map((t) => statements[t.statement]?.byCode[t.code]);
      const first = targets[0];
      // Un poste absent (TFT non produit en SMT) : pas de rapprochement, donc pas de contrôle faussement en échec.
      if (first && lines.every((l) => l !== undefined)) {
        const expected = lines.reduce((acc, line, i) => acc.add(columnOf(line!, targets[i]!.column)), Money.zero());
        reconciles = { statement: first.statement, code: targets.map((t) => t.code).join(" + "), expected, ok: expected.eq(total) };
      }
    }
    out.push({
      number: def.number,
      title: def.title,
      kind: def.kind,
      rows,
      total,
      previousTotal,
      ...(reconciles ? { reconciles } : {}),
      status: "COMPUTED",
    });
  }
  return out;
}
