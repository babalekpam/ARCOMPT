// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Aides pures du module paie (testables sans React ni réseau).
 */
import type { BadgeTone } from "@/components/ui/Badge";
// Imports relatifs : le projet vitest « web » ne résout pas l'alias `@/` à l'exécution.
import { fromMinor, toMinor } from "../../lib/money";
import type { Locale } from "../../lib/i18n";
import type { PayrollRunStatus, PayslipInputs } from "./types";

/** Valeur masquée par l'API pour les rôles sans accès aux champs sensibles ("***", "****1234"). */
export function isMasked(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("*");
}

/**
 * Convertit une saisie utilisateur en chaîne canonique ("1234.5000").
 * Renvoie null si vide ou invalide. Zéro et négatifs sont refusés sauf option.
 */
export function parseAmount(input: string, opts: { allowZero?: boolean; allowNegative?: boolean } = {}): string | null {
  if (input.trim() === "") return null;
  try {
    const minor = toMinor(input);
    if (minor === 0n && !opts.allowZero) return null;
    if (minor < 0n && !opts.allowNegative) return null;
    return fromMinor(minor);
  } catch {
    return null;
  }
}

/** Libellé d'une période de paie : « mars 2025 » / « March 2025 ». */
export function periodLabel(year: number, month: number, locale: Locale): string {
  const fmt = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  return fmt.format(new Date(Date.UTC(year, month - 1, 1)));
}

export function runTone(status: PayrollRunStatus): BadgeTone {
  switch (status) {
    case "PAID":
      return "success";
    case "VALIDATED":
      return "success";
    case "COMPUTED":
      return "info";
    default:
      return "neutral";
  }
}

/** Ligne de variables mensuelles saisie à l'écran pour un salarié. */
export interface VariableRow {
  employeeId: string;
  overtime: string;
  bonusLabel: string;
  bonus: string;
  absences: string;
  advance: string;
}

export const emptyVariableRow = (employeeId: string): VariableRow => ({ employeeId, overtime: "", bonusLabel: "", bonus: "", absences: "", advance: "" });

/** Pré-remplit une ligne depuis les variables d'un bulletin déjà calculé. */
export function rowFromInputs(employeeId: string, inputs: PayslipInputs | undefined): VariableRow {
  const row = emptyVariableRow(employeeId);
  if (!inputs) return row;
  if (inputs.overtime) row.overtime = inputs.overtime;
  if (inputs.advance) row.advance = inputs.advance;
  const bonus = inputs.bonuses?.[0];
  if (bonus) {
    row.bonusLabel = bonus.label;
    row.bonus = bonus.amount;
  }
  const absence = inputs.deductions?.[0];
  if (absence) row.absences = absence.amount;
  return row;
}

/**
 * Construit le corps de /runs/:id/compute à partir des lignes saisies.
 * Les salariés sans variable sont omis ; les montants invalides sont signalés.
 */
export function buildComputeInputs(rows: VariableRow[], labels: { bonus: string; absences: string }): { inputs: Record<string, PayslipInputs>; invalid: string[] } {
  const inputs: Record<string, PayslipInputs> = {};
  const invalid: string[] = [];
  for (const r of rows) {
    const out: PayslipInputs = {};
    const check = (raw: string, field: string): string | undefined => {
      if (raw.trim() === "") return undefined;
      const v = parseAmount(raw);
      if (!v) invalid.push(`${r.employeeId}:${field}`);
      return v ?? undefined;
    };
    const overtime = check(r.overtime, "overtime");
    const bonus = check(r.bonus, "bonus");
    const absences = check(r.absences, "absences");
    const advance = check(r.advance, "advance");
    if (overtime) out.overtime = overtime;
    if (bonus) out.bonuses = [{ label: r.bonusLabel.trim() || labels.bonus, amount: bonus }];
    if (absences) out.deductions = [{ label: labels.absences, amount: absences }];
    if (advance) out.advance = advance;
    if (Object.keys(out).length > 0) inputs[r.employeeId] = out;
  }
  return { inputs, invalid };
}

/**
 * Pack d'un bulletin non officiel, nommé comme la mention l'affiche
 * (« CI 2025.1 ») ; `null` quand le bulletin fait autorité.
 *
 * Un bulletin n'est jamais refusé — c'est aussi une pièce comptable — mais
 * quand le pack pays n'est pas publié, l'API le marque `official: false` et
 * fournit `packNotice`. L'un ou l'autre suffit à déclencher la mention : mieux
 * vaut l'imprimer une fois de trop que de remettre au salarié un bulletin qui
 * se donne pour officiel.
 */
export function payslipDraftPack(view: { official?: boolean; packNotice?: string | null; company: { countryCode: string }; run: { packVersion: string } }): string | null {
  const draft = view.official === false || (typeof view.packNotice === "string" && view.packNotice.trim().length > 0);
  if (!draft) return null;
  return `${view.company.countryCode.toUpperCase()} ${view.run.packVersion}`;
}

export function employeeName(e: { firstName: string; lastName: string }): string {
  return `${e.lastName.toUpperCase()} ${e.firstName}`.trim();
}

/** Liste de comptes de trésorerie proposés pour le paiement (classe 5). */
export const TREASURY_ACCOUNTS = ["521", "571", "5381"] as const;
