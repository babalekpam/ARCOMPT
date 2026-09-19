import type { BankRule } from "./types.js";

/**
 * Règles d'imputation : premier motif (par priorité croissante) qui
 * correspond au libellé de la ligne de relevé. Motif = sous-chaîne
 * insensible à la casse et aux accents, ou expression régulière.
 */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function ruleMatches(rule: BankRule, label: string): boolean {
  if (!rule.active || !rule.pattern) return false;
  if (rule.isRegex) {
    try {
      return new RegExp(rule.pattern, "i").test(label);
    } catch {
      return false;
    }
  }
  return fold(label).includes(fold(rule.pattern));
}

/** Renvoie la règle applicable à une ligne (compte de trésorerie donné ou règle globale), ou null. */
export function findRule(rules: BankRule[], label: string, treasuryAccountId: string): BankRule | null {
  const applicable = rules
    .filter((r) => r.treasuryAccountId === null || r.treasuryAccountId === treasuryAccountId)
    .sort((a, b) => a.priority - b.priority || (a.treasuryAccountId ? -1 : 1));
  return applicable.find((r) => ruleMatches(r, label)) ?? null;
}
