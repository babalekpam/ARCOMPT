import { Money, type AccountingSystem } from "@arcompt/ledger";
import { evalFormula, type BalanceIndex } from "./formula.js";
import type { ComputedNote, ComputedStatement, NoteDefinition, StatementCode } from "./types.js";

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
      const st = statements[def.reconciles.statement];
      const line = st?.byCode[def.reconciles.code];
      if (line) {
        const col = def.reconciles.column ?? "net";
        const expected = col === "brut" ? (line.brut ?? line.net) : col === "amort_prov" ? (line.amortProv ?? Money.zero()) : line.net;
        reconciles = { statement: def.reconciles.statement, code: def.reconciles.code, expected, ok: expected.eq(total) };
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
