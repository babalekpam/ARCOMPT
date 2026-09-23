// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { packRules, type CountryPack } from "@arcompt/country-packs";
import { CURRENCY_DECIMALS, Money, sum } from "@arcompt/ledger";
import { Decimal, RuleError, type RuleSet, type Scope, type Value } from "@arcompt/rules";
import { PayrollError } from "./errors.js";
import { derivePayrollScheme, type DeriveSchemeOptions, type PayrollScheme } from "./scheme.js";
import type { Allowance, PayrollPeriod, PayslipComputation, PayslipInputs, PayslipLine } from "./types.js";

/** Données du salarié nécessaires au calcul (sous-ensemble d'Employee). */
export interface PayslipEmployee {
  baseSalary: string;
  allowances?: Allowance[];
  dependants?: number;
}

export interface ComputeOptions extends DeriveSchemeOptions {
  /** Schéma déjà dérivé (évite de le recalculer pour chaque salarié du cycle). */
  scheme?: PayrollScheme;
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

export function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export function periodLabel(year: number, month: number): string {
  return `${MONTHS_FR[month - 1] ?? month} ${year}`;
}

/**
 * Calcul pur d'un bulletin : aucune logique pays, tout vient des règles du
 * pack évaluées à la date de fin de période. Les montants sont arrondis à la
 * décimale de la devise du pack (0 pour XOF/XAF).
 *
 * Éléments de brut : salaire de base, indemnités récurrentes, heures
 * supplémentaires, primes, moins les retenues avant cotisations (absences).
 * Les indemnités non soumises (taxable: false) entrent dans le brut versé
 * mais pas dans l'assiette `salaire_brut` transmise aux règles.
 */
export function computePayslip(
  pack: CountryPack,
  employee: PayslipEmployee,
  period: PayrollPeriod,
  inputs: PayslipInputs = {},
  opts: ComputeOptions = {},
): PayslipComputation {
  const scheme = opts.scheme ?? derivePayrollScheme(pack, opts);
  const rules = packRules(pack);
  const date = lastDayOfMonth(period.year, period.month);
  const currency = scheme.currency;
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const round = (m: Money) => m.roundTo(decimals);
  const parse = (v: string, what: string) => {
    try {
      return round(Money.parse(v));
    } catch (e) {
      throw new PayrollError("INVALID_INPUT", `${what} : ${(e as Error).message}`);
    }
  };
  const lines: PayslipLine[] = [];
  const earning = (id: string, label: string, amount: Money, extra: Partial<PayslipLine> = {}): void => {
    if (amount.isZero()) return;
    if (amount.isNegative()) throw new PayrollError("INVALID_INPUT", `${label} : montant négatif`);
    lines.push({ id, kind: "EARNING", label, base: amount.toString(), rate: null, employee_amount: amount.toString(), employer_amount: Money.zero().toString(), account: scheme.accounts.gross, ...extra });
  };

  // --- Éléments de brut -----------------------------------------------------
  const base = parse(employee.baseSalary, "Salaire de base");
  if (!base.isPositive()) throw new PayrollError("INVALID_INPUT", "Salaire de base : montant nul ou négatif");
  earning("base", "Salaire de base", base);
  let nonTaxable = Money.zero();
  for (const a of employee.allowances ?? []) {
    const amount = parse(a.amount, a.label);
    earning(`allowance.${a.code}`, a.label, amount);
    if (a.taxable === false) nonTaxable = nonTaxable.add(amount);
  }
  if (inputs.overtime) earning("overtime", "Heures supplémentaires", parse(inputs.overtime, "Heures supplémentaires"));
  (inputs.bonuses ?? []).forEach((b, i) => earning(`bonus.${i + 1}`, b.label, parse(b.amount, b.label)));
  let deductions = Money.zero();
  (inputs.deductions ?? []).forEach((d, i) => {
    const amount = parse(d.amount, d.label);
    if (amount.isZero()) return;
    if (amount.isNegative()) throw new PayrollError("INVALID_INPUT", `${d.label} : montant négatif`);
    deductions = deductions.add(amount);
    lines.push({ id: `deduction.${i + 1}`, kind: "DEDUCTION", label: d.label, base: amount.toString(), rate: null, employee_amount: amount.toString(), employer_amount: "0.0000", account: scheme.accounts.gross });
  });

  const gross = sum(lines.filter((l) => l.kind === "EARNING").map((l) => Money.parse(l.employee_amount))).sub(deductions);
  if (gross.isNegative()) throw new PayrollError("INVALID_INPUT", "Retenues supérieures aux éléments de brut");
  /** Brut soumis aux cotisations et à l'impôt (variable `salaire_brut` du pack). */
  const taxableGross = gross.sub(nonTaxable);

  const scope: Scope = {
    ...(inputs.variables ?? {}),
    salaire_base: base.toString(),
    salaire_brut: taxableGross.toString(),
    nb_dependants: String(employee.dependants ?? 0),
  };
  const evalMoney = (id: string): Money => round(toMoney(evaluate(rules, id, date, scope), id));
  const evalRate = (id: string | null): string | null => {
    if (!id) return null;
    const v = evaluate(rules, id, date, scope);
    return v instanceof Decimal ? v.toString() : null;
  };

  // --- Cotisations sociales ---------------------------------------------------
  let employeeContributions = Money.zero();
  let employerContributions = Money.zero();
  for (const c of scheme.contributions) {
    const cBase = c.baseRuleId ? evalMoney(c.baseRuleId) : taxableGross;
    const employeeAmount = c.employeeRuleId ? evalMoney(c.employeeRuleId) : Money.zero();
    const employerAmount = c.employerRuleId ? evalMoney(c.employerRuleId) : Money.zero();
    employeeContributions = employeeContributions.add(employeeAmount);
    employerContributions = employerContributions.add(employerAmount);
    lines.push({
      id: c.id,
      kind: "CONTRIBUTION",
      label: c.label,
      base: cBase.toString(),
      rate: evalRate(c.employeeRateRuleId),
      employee_amount: employeeAmount.toString(),
      employer_amount: employerAmount.toString(),
      account: c.account,
      ...(c.employeeRuleId || c.employerRuleId ? { rule_id: c.employeeRuleId ?? c.employerRuleId! } : {}),
    });
  }

  // --- Impôt sur salaires -----------------------------------------------------
  let incomeTax = Money.zero();
  let taxableBase = taxableGross.sub(employeeContributions);
  if (scheme.incomeTax) {
    if (scheme.incomeTax.baseRuleId) taxableBase = evalMoney(scheme.incomeTax.baseRuleId);
    incomeTax = evalMoney(scheme.incomeTax.ruleId);
    lines.push({
      id: scheme.incomeTax.id,
      kind: "TAX",
      label: scheme.incomeTax.label,
      base: taxableBase.toString(),
      rate: null,
      employee_amount: incomeTax.toString(),
      employer_amount: "0.0000",
      account: scheme.incomeTax.account,
      rule_id: scheme.incomeTax.ruleId,
    });
  }

  // --- Net ---------------------------------------------------------------------
  const net = gross.sub(employeeContributions).sub(incomeTax);
  if (scheme.netRuleId) {
    // Le net du pack porte sur le brut soumis : on lui rajoute les éléments non soumis versés.
    const packNet = evalMoney(scheme.netRuleId).add(nonTaxable);
    if (!packNet.eq(net)) {
      // Les montants restent dans `details` (jamais dans un message susceptible d'être journalisé).
      throw new PayrollError("NET_MISMATCH", "Net calculé différent du net du pack : une retenue du pack n'est pas reconnue par le schéma", {
        net: net.toString(),
        packNet: packNet.toString(),
        lines: lines.map((l) => l.id),
      });
    }
  }
  const advance = inputs.advance ? parse(inputs.advance, "Acompte") : Money.zero();
  if (advance.isNegative()) throw new PayrollError("INVALID_INPUT", "Acompte : montant négatif");
  if (!advance.isZero()) {
    lines.push({ id: "advance", kind: "ADVANCE", label: "Acompte versé", base: advance.toString(), rate: null, employee_amount: advance.toString(), employer_amount: "0.0000", account: scheme.accounts.advances });
  }
  const netToPay = net.sub(advance);
  if (netToPay.isNegative()) throw new PayrollError("INVALID_INPUT", "Acompte supérieur au net du mois");

  return {
    period,
    date,
    currency,
    packVersion: scheme.packVersion,
    gross,
    taxableBase,
    employeeContributions,
    employerContributions,
    incomeTax,
    net,
    advance,
    netToPay,
    employerCost: gross.add(employerContributions),
    lines,
  };
}

function evaluate(rules: RuleSet, id: string, date: string, scope: Scope): Value {
  try {
    return rules.evaluate(id, date, scope).value;
  } catch (e) {
    if (e instanceof RuleError) throw new PayrollError("RULE_ERROR", `Règle ${id} : ${e.message}`, { ruleId: id });
    throw e;
  }
}

function toMoney(v: Value, id: string): Money {
  if (!(v instanceof Decimal)) throw new PayrollError("RULE_ERROR", `Règle ${id} : un montant était attendu`, { ruleId: id });
  // Decimal est à 10 décimales ; Money à 4 : arrondi intermédiaire avant l'arrondi devise.
  return Money.parse(v.round(4).toString());
}
