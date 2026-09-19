import { Money, type AccountBalance } from "@arcompt/ledger";

/**
 * Formules de la table de passage comptes → postes.
 *
 * Un terme est : signe optionnel, racine de compte, filtre optionnel de sens.
 *   "+411"    solde du compte 411 et de ses sous-comptes (débit − crédit)
 *   "+411:D"  seulement les soldes débiteurs (par compte de dernier niveau)
 *   "+491:C"  seulement les soldes créditeurs, exprimés en positif
 *   "-6031"   solde retranché
 *
 * Un terme "N-1" s'écrit avec le préfixe "prev:" ("+prev:521") et lit la
 * balance de l'exercice précédent (tableau des flux).
 *
 * Deux filtres de mouvement servent au tableau des flux :
 *   ":DM"  total des débits de l'exercice (remboursements d'emprunts, dividendes payés)
 *   ":CM"  total des crédits de l'exercice (sorties d'immobilisations en valeur brute)
 *
 * Avec le filtre :D, la contribution est le solde débiteur (D − C si > 0).
 * Avec :C, la contribution est le solde créditeur (C − D si > 0).
 * Sans filtre, la contribution est D − C (peut être négative) ; le signe du
 * terme s'applique ensuite.
 */
export type Side = "D" | "C" | "DM" | "CM";

export interface Term {
  sign: 1 | -1;
  root: string;
  side: Side | null;
  prev: boolean;
}

const TERM = /^([+-])?(prev:)?(\d{1,8})(?::(DM|CM|D|C))?$/;

export function parseTerm(src: string): Term {
  const m = TERM.exec(src.trim());
  if (!m) throw new Error(`Terme de formule invalide : "${src}"`);
  return {
    sign: m[1] === "-" ? -1 : 1,
    prev: m[2] !== undefined,
    root: m[3]!,
    side: (m[4] as Side | undefined) ?? null,
  };
}

/** Balance indexée : numéro de compte → totaux, uniquement les comptes de dernier niveau. */
export type BalanceIndex = Map<string, { debit: Money; credit: Money }>;

export function indexBalance(rows: AccountBalance[]): BalanceIndex {
  const idx: BalanceIndex = new Map();
  for (const r of rows) {
    const cur = idx.get(r.accountNumber);
    idx.set(r.accountNumber, cur ? { debit: cur.debit.add(r.debit), credit: cur.credit.add(r.credit) } : { debit: r.debit, credit: r.credit });
  }
  return idx;
}

export function evalTerm(term: Term, current: BalanceIndex, previous: BalanceIndex): { amount: Money; accounts: string[] } {
  const idx = term.prev ? previous : current;
  let total = Money.zero();
  const accounts: string[] = [];
  for (const [number, v] of idx) {
    if (!number.startsWith(term.root)) continue;
    const solde = v.debit.sub(v.credit);
    let contribution: Money;
    if (term.side === "D") contribution = solde.isPositive() ? solde : Money.zero();
    else if (term.side === "C") contribution = solde.isNegative() ? solde.neg() : Money.zero();
    else if (term.side === "DM") contribution = v.debit;
    else if (term.side === "CM") contribution = v.credit;
    else contribution = solde;
    if (!contribution.isZero()) accounts.push(number);
    total = total.add(contribution);
  }
  return { amount: term.sign === 1 ? total : total.neg(), accounts };
}

export function evalFormula(terms: string[], current: BalanceIndex, previous: BalanceIndex): { amount: Money; accounts: string[] } {
  let total = Money.zero();
  const accounts = new Set<string>();
  for (const t of terms) {
    const r = evalTerm(parseTerm(t), current, previous);
    total = total.add(r.amount);
    r.accounts.forEach((a) => accounts.add(a));
  }
  return { amount: total, accounts: [...accounts].sort() };
}
