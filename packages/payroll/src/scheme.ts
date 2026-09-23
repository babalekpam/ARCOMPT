// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { packRules, type CountryPack } from "@arcompt/country-packs";
import { PayrollError } from "./errors.js";

/**
 * Schéma de paie dérivé d'un pack pays.
 *
 * Aucune logique pays en dur : les cotisations sont découvertes par convention
 * sur les identifiants de règles du pack :
 *   - `payroll.<cotisation>.employee`  part salariale
 *   - `payroll.<cotisation>.employer`  part patronale
 *   - `payroll.<cotisation>.base`      assiette (facultatif ; défaut brut soumis)
 *   - `payroll.<cotisation>.…employee_rate` / `…employer_rate` taux (facultatif, pour l'affichage)
 *   - `payroll.its`                    impôt sur les traitements et salaires (barème via tranche())
 *   - `payroll.its.base`               base imposable (facultatif ; défaut brut − retenues salariales)
 *   - `payroll.net`                    net à payer selon le pack (contrôle de cohérence)
 *
 * Les comptes SYSCOHADA sont communs à l'espace OHADA : 661 brut, 664 charges
 * patronales, 421 acomptes, 422 rémunérations dues, 431 organismes sociaux,
 * 447 impôts retenus à la source. Un dossier peut les surcharger (sous-comptes).
 */
export interface PayrollAccounts {
  /** Rémunérations directes (charge). */
  gross: string;
  /** Charges sociales patronales (charge). */
  employerCharges: string;
  /** Personnel, avances et acomptes. */
  advances: string;
  /** Personnel, rémunérations dues (lettrable, par salarié). */
  netDue: string;
  /** Organismes sociaux (défaut pour toute cotisation). */
  socialBody: string;
  /** État, impôts retenus à la source (ITS). */
  incomeTax: string;
}

export const DEFAULT_PAYROLL_ACCOUNTS: PayrollAccounts = {
  gross: "661",
  employerCharges: "664",
  advances: "421",
  netDue: "422",
  socialBody: "431",
  incomeTax: "447",
};

export interface PayrollContributionScheme {
  /** Identifiant court issu de la règle ("cnps", "ipres"…). */
  id: string;
  /** Code de déclaration (identifiant en majuscules : "CNPS"). */
  kind: string;
  label: string;
  employeeRuleId: string | null;
  employerRuleId: string | null;
  baseRuleId: string | null;
  employeeRateRuleId: string | null;
  employerRateRuleId: string | null;
  /** Compte de tiers crédité (431 par défaut). */
  account: string;
  /** Libellés des règles du pack (affichés sur le bulletin). */
  employeeLabel: string;
  employerLabel: string;
}

export interface PayrollIncomeTaxScheme {
  id: string;
  kind: string;
  label: string;
  ruleId: string;
  baseRuleId: string | null;
  account: string;
}

export interface PayrollScheme {
  packCode: string;
  packVersion: string;
  currency: string;
  socialSecurityBody: string | null;
  accounts: PayrollAccounts;
  contributions: PayrollContributionScheme[];
  incomeTax: PayrollIncomeTaxScheme | null;
  netRuleId: string | null;
}

export interface DeriveSchemeOptions {
  /** Surcharge des comptes (sous-comptes propres au dossier). */
  accounts?: Partial<PayrollAccounts>;
  /** Comptes par cotisation (ex. { cnps: "4311" }). */
  contributionAccounts?: Record<string, string>;
}

const CONTRIBUTION_RE = /^payroll\.([a-z0-9_]+)\.(employee|employer)$/;
const RESERVED = new Set(["its", "net"]);

export function derivePayrollScheme(pack: CountryPack, opts: DeriveSchemeOptions = {}): PayrollScheme {
  const accounts: PayrollAccounts = { ...DEFAULT_PAYROLL_ACCOUNTS, ...strip(opts.accounts ?? {}) };
  const set = packRules(pack);
  const ids = set.ids();
  const has = (id: string) => ids.includes(id);
  const labelOf = (id: string): string | undefined => pack.payroll.rules.find((r) => r.id === id)?.label;

  const found = new Map<string, { employee?: string; employer?: string }>();
  for (const id of ids) {
    const m = CONTRIBUTION_RE.exec(id);
    if (!m) continue;
    const name = m[1]!;
    if (RESERVED.has(name)) continue;
    const entry = found.get(name) ?? {};
    if (m[2] === "employee") entry.employee = id;
    else entry.employer = id;
    found.set(name, entry);
  }

  const body = pack.identity.social_security_body ?? null;
  const contributions: PayrollContributionScheme[] = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rules]) => {
      const rateFor = (side: "employee" | "employer") => {
        const candidates = ids.filter((id) => id.startsWith(`payroll.${name}.`) && id.endsWith(`${side}_rate`));
        return candidates.length === 1 ? candidates[0]! : null;
      };
      const kind = name.toUpperCase();
      const label = body && body.toLowerCase() === name ? body : kind;
      return {
        id: name,
        kind,
        label,
        employeeRuleId: rules.employee ?? null,
        employerRuleId: rules.employer ?? null,
        baseRuleId: has(`payroll.${name}.base`) ? `payroll.${name}.base` : null,
        employeeRateRuleId: rateFor("employee"),
        employerRateRuleId: rateFor("employer"),
        account: opts.contributionAccounts?.[name] ?? accounts.socialBody,
        employeeLabel: (rules.employee && labelOf(rules.employee)) ?? `${label}, part salariale`,
        employerLabel: (rules.employer && labelOf(rules.employer)) ?? `${label}, part patronale`,
      };
    });

  const incomeTax: PayrollIncomeTaxScheme | null = has("payroll.its")
    ? {
        id: "its",
        kind: "ITS",
        label: labelOf("payroll.its") ?? "Impôt sur les traitements et salaires",
        ruleId: "payroll.its",
        baseRuleId: has("payroll.its.base") ? "payroll.its.base" : null,
        account: accounts.incomeTax,
      }
    : null;

  if (contributions.length === 0 && !incomeTax) {
    throw new PayrollError("SCHEME_INCOMPLETE", `Pack ${pack.code}@${pack.version} : aucune règle de paie (payroll.<cotisation>.employee/employer, payroll.its)`);
  }

  return {
    packCode: pack.code,
    packVersion: `${pack.code}@${pack.version}`,
    currency: pack.identity.currency,
    socialSecurityBody: body,
    accounts,
    contributions,
    incomeTax,
    netRuleId: has("payroll.net") ? "payroll.net" : null,
  };
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
