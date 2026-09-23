import { CURRENCY_DECIMALS, Money, isCurrencyCode, normalizeCurrency, type AccountBalance } from "@arcompt/ledger";
import { runControls } from "./controls.js";
import { evalFormula, indexBalance, type BalanceIndex } from "./formula.js";
import { computeNotes } from "./notes.js";
import { DEFAULT_TEMPLATE_VERSION, TEMPLATES } from "./templates/syscohada-revise/index.js";
import type { ComputedLine, ComputedStatement, LineDefinition, StatementCode, StatementsInput, StatementsOutput, StatementTemplate } from "./types.js";

/**
 * Moteur d'états : fonction pure. Même balance + même version de gabarit ⇒
 * mêmes états. Aucun accès à la base, aucune écriture.
 */
export function computeStatements(input: StatementsInput): StatementsOutput {
  const version = input.templateVersion ?? DEFAULT_TEMPLATE_VERSION;
  const template = TEMPLATES[version];
  if (!template) throw new Error(`Version de gabarit inconnue : ${version}`);
  // Les états sont mono-devise : la devise de présentation doit être un code
  // ISO 4217, et la balance fournie doit déjà y être exprimée.
  if (!isCurrencyCode(input.currency)) throw new Error(`Devise de présentation invalide : "${input.currency}" (code ISO 4217 attendu)`);
  const currency = normalizeCurrency(input.currency);

  const current = indexBalance(input.balance);
  const previous = indexBalance(input.previousBalance ?? []);
  const hasPrevious = (input.previousBalance?.length ?? 0) > 0;

  const statements = {} as Record<StatementCode, ComputedStatement>;
  for (const st of template.statements) {
    if (st.code === "TFT" && input.system === "SMT") continue; // pas de TFT en système minimal
    statements[st.code] = computeStatement(st, current, previous, input.system, hasPrevious);
  }

  const notes = computeNotes(template.notes, statements, current, previous, input.system);
  const covered = coveredAccounts(statements);
  const orphanAccounts = [...current.entries()]
    .filter(([n, v]) => !n.startsWith("9") && !v.debit.sub(v.credit).isZero() && !covered.has(n))
    .map(([n]) => n)
    .sort();
  const controls = runControls({
    statements,
    notes,
    current,
    previous,
    hasPrevious,
    orphanAccounts,
    system: input.system,
    currency,
    ...(input.balanceCurrency ? { balanceCurrency: normalizeCurrency(input.balanceCurrency) } : {}),
    subUnitAccounts: subUnitAccounts(input.balance, currency),
  });

  return {
    templateId: template.id,
    templateVersion: template.version,
    system: input.system,
    currency,
    fiscalYearCode: input.fiscalYearCode,
    statements,
    notes,
    controls,
    publishable: controls.every((c) => c.ok || c.severity !== "BLOCKING"),
    orphanAccounts,
  };
}

function computeStatement(st: StatementTemplate, current: BalanceIndex, previous: BalanceIndex, system: StatementsInput["system"], hasPrevious: boolean): ComputedStatement {
  const byCode: Record<string, ComputedLine> = {};
  const lines: ComputedLine[] = [];
  // Les postes de somme référencent des postes définis avant ou après eux : deux passes.
  const defs = st.lines.filter((l) => !l.systems || l.systems.includes(system));
  for (const def of defs) {
    if (def.sum) continue;
    const line = computeLeaf(def, current, previous, hasPrevious);
    byCode[def.code] = line;
  }
  let pending = defs.filter((d) => d.sum);
  let guard = 0;
  while (pending.length > 0) {
    const next: LineDefinition[] = [];
    for (const def of pending) {
      const refs = def.sum!.map((s) => (typeof s === "string" ? { code: s, sign: 1 as const } : s));
      if (refs.every((r) => byCode[r.code])) {
        byCode[def.code] = computeSum(def, refs, byCode);
      } else {
        next.push(def);
      }
    }
    if (next.length === pending.length && ++guard > 1) {
      throw new Error(`Gabarit ${st.code} : postes de somme irrésolubles (${next.map((d) => d.code).join(", ")})`);
    }
    pending = next;
  }
  for (const def of defs) lines.push(byCode[def.code]!);
  return { code: st.code, title: st.title, lines, byCode };
}

function computeLeaf(def: LineDefinition, current: BalanceIndex, previous: BalanceIndex, hasPrevious: boolean): ComputedLine {
  const style = def.style ?? "line";
  const base = { code: def.code, label: def.label, style, ...(def.note !== undefined ? { note: def.note } : {}) };
  if (def.brut) {
    const brut = evalFormula(def.brut, current, previous);
    const amort = def.amort_prov ? evalFormula(def.amort_prov, current, previous) : { amount: Money.zero(), accounts: [] };
    const prevBrut = hasPrevious ? evalFormula(def.brut, previous, previous) : { amount: Money.zero(), accounts: [] };
    const prevAmort = hasPrevious && def.amort_prov ? evalFormula(def.amort_prov, previous, previous) : { amount: Money.zero(), accounts: [] };
    return {
      ...base,
      brut: brut.amount,
      amortProv: amort.amount,
      net: brut.amount.sub(amort.amount),
      previousNet: prevBrut.amount.sub(prevAmort.amount),
      accounts: [...new Set([...brut.accounts, ...amort.accounts])].sort(),
    };
  }
  const formula = def.formula ?? [];
  const cur = evalFormula(formula, current, previous);
  // Colonne N-1 : on rejoue la formule avec la balance N-1 comme « courante ».
  // Les termes prev:/mouvements n'ont pas de sens en N-1 sans balance N-2 : ils valent 0.
  const prev = hasPrevious ? evalFormula(formula.filter((t) => !t.includes("prev:") && !/:(DM|CM)$/.test(t)), previous, new Map()) : { amount: Money.zero(), accounts: [] };
  return { ...base, net: cur.amount, previousNet: prev.amount, accounts: cur.accounts };
}

function computeSum(def: LineDefinition, refs: Array<{ code: string; sign: 1 | -1 }>, byCode: Record<string, ComputedLine>): ComputedLine {
  let brut: Money | undefined;
  let amort: Money | undefined;
  let net = Money.zero();
  let prev = Money.zero();
  const accounts = new Set<string>();
  for (const r of refs) {
    const l = byCode[r.code]!;
    const signed = (m: Money) => (r.sign === 1 ? m : m.neg());
    if (l.brut !== undefined) brut = (brut ?? Money.zero()).add(signed(l.brut));
    if (l.amortProv !== undefined) amort = (amort ?? Money.zero()).add(signed(l.amortProv));
    net = net.add(signed(l.net));
    prev = prev.add(signed(l.previousNet));
    l.accounts.forEach((a) => accounts.add(a));
  }
  return {
    code: def.code,
    label: def.label,
    style: def.style ?? "total",
    ...(def.note !== undefined ? { note: def.note } : {}),
    ...(brut !== undefined ? { brut } : {}),
    ...(amort !== undefined ? { amortProv: amort } : {}),
    net,
    previousNet: prev,
    accounts: [...accounts].sort(),
  };
}

/**
 * Comptes dont le solde porte des fractions plus fines que l'unité monétaire de
 * la devise de présentation. En XOF ou en XAF, qui n'ont pas de sous-unité, des
 * centimes ne peuvent venir que d'une conversion : ils signalent un arrondi à
 * trancher avant publication, pas une erreur d'équilibre.
 */
function subUnitAccounts(rows: AccountBalance[], currency: string): string[] {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.debit.roundTo(decimals).eq(r.debit) || !r.credit.roundTo(decimals).eq(r.credit)) out.add(r.accountNumber);
  }
  return [...out].sort();
}

/**
 * Comptes repris par au moins un poste : classes 1 à 5 par le bilan, classes
 * 6 à 8 par le compte de résultat (le poste CJ du passif absorbe tout le
 * résultat et ne peut donc pas servir à détecter un compte de gestion oublié).
 */
function coveredAccounts(statements: Record<StatementCode, ComputedStatement>): Set<string> {
  const set = new Set<string>();
  for (const l of statements.COMPTE_RESULTAT?.lines ?? []) l.accounts.forEach((a) => set.add(a));
  for (const code of ["BILAN_ACTIF", "BILAN_PASSIF"] as const) {
    for (const l of statements[code]?.lines ?? []) l.accounts.filter((a) => /^[1-5]/.test(a)).forEach((a) => set.add(a));
  }
  return set;
}

/** Balance de clôture N à partir des soldes (utilitaire pour les fixtures et l'API). */
export function balanceFromRows(rows: Array<{ account: string; label?: string; debit: string; credit: string }>): AccountBalance[] {
  return rows.map((r) => ({
    accountNumber: r.account,
    label: r.label ?? "",
    class: Number(r.account[0]) as AccountBalance["class"],
    debit: Money.parse(r.debit),
    credit: Money.parse(r.credit),
  }));
}
