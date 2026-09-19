import { Decimal, evalExpression, isBareme, RuleError, type Bareme, type Scope, type Value } from "./expression.js";

/**
 * Jeu de règles versionné dans le temps. Chaque règle porte valid_from /
 * valid_to ; la période calculée choisit la version applicable, ce qui
 * permet de recalculer une déclaration passée avec les anciens taux.
 */
export interface RuleDefinition {
  /** Identifiant stable (ex. "vat.standard_rate", "payroll.its"). */
  id: string;
  label?: string;
  /** Expression déclarative, ou constante numérique, ou barème. */
  expr?: string;
  value?: string | number | Bareme;
  /** Intervalle de validité (dates ISO, valid_to inclus ; absent = sans fin). */
  valid_from: string;
  valid_to?: string;
  /** Règles dont dépend celle-ci (évaluées d'abord, injectées dans le scope sous leur id). */
  depends_on?: string[];
  /** Source légale (loi de finances, article). */
  source?: string;
}

export interface RuleResult {
  id: string;
  value: Value;
  version: RuleDefinition;
}

export class RuleSet {
  private byId = new Map<string, RuleDefinition[]>();

  constructor(rules: RuleDefinition[] = []) {
    for (const r of rules) this.add(r);
  }

  add(rule: RuleDefinition): void {
    const list = this.byId.get(rule.id) ?? [];
    list.push(rule);
    list.sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    this.byId.set(rule.id, list);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  /** Version applicable à une date. */
  resolve(id: string, date: string): RuleDefinition {
    const list = this.byId.get(id);
    if (!list) throw new RuleError(`Règle inconnue : ${id}`);
    const hit = [...list].reverse().find((r) => r.valid_from <= date && (r.valid_to === undefined || date <= r.valid_to));
    if (!hit) throw new RuleError(`Règle ${id} : aucune version valide au ${date}`);
    return hit;
  }

  /** Évalue une règle (et ses dépendances) à une date donnée. */
  evaluate(id: string, date: string, scope: Scope = {}, stack: string[] = []): RuleResult {
    if (stack.includes(id)) throw new RuleError(`Dépendance circulaire : ${[...stack, id].join(" → ")}`);
    const rule = this.resolve(id, date);
    const local: Scope = { ...scope };
    for (const dep of rule.depends_on ?? []) {
      local[dep] = this.evaluate(dep, date, scope, [...stack, id]).value;
    }
    let value: Value;
    if (rule.expr !== undefined) {
      value = evalExpression(rule.expr, local);
    } else if (isBareme(rule.value)) {
      value = rule.value;
    } else if (rule.value !== undefined) {
      value = Decimal.of(rule.value);
    } else {
      throw new RuleError(`Règle ${id} : ni expr ni value`);
    }
    return { id, value, version: rule };
  }

  /** Vérifie que les intervalles de validité d'une même règle ne se chevauchent pas. */
  validate(): string[] {
    const problems: string[] = [];
    for (const [id, list] of this.byId) {
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        if (prev.valid_to === undefined || prev.valid_to >= cur.valid_from) {
          problems.push(`${id} : les versions ${prev.valid_from} et ${cur.valid_from} se chevauchent`);
        }
      }
      for (const r of list) {
        if (r.expr === undefined && r.value === undefined) problems.push(`${id} : ni expr ni value`);
        if (r.valid_to !== undefined && r.valid_to < r.valid_from) problems.push(`${id} : valid_to avant valid_from`);
      }
    }
    return problems;
  }
}
