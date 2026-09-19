import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { referencedVariables, RuleSet, type RuleDefinition } from "@arcompt/rules";
import { CountryPackSchema, type CountryPack } from "./schema.js";

const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "packs");

export class PackError extends Error {
  override name = "PackError";
}

export function listPackCodes(dir = PACKS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => !f.startsWith("_") && statSync(join(dir, f)).isDirectory())
    .sort();
}

export function readPackFile(code: string, dir = PACKS_DIR): unknown {
  const file = join(dir, code, "pack.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Charge et valide un pack. Lève PackError avec la liste des problèmes. */
export function loadPack(code: string, dir = PACKS_DIR): CountryPack {
  const raw = readPackFile(code, dir);
  const problems = validatePackData(raw);
  if (problems.length > 0) throw new PackError(`Pack ${code} invalide :\n - ${problems.join("\n - ")}`);
  return CountryPackSchema.parse(raw);
}

/** Validation complète : schéma, versions de règles, dépendances, variables. */
export function validatePackData(raw: unknown): string[] {
  const parsed = CountryPackSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`);
  }
  const pack = parsed.data;
  const problems: string[] = [];
  const allRules: RuleDefinition[] = [...pack.vat.rules, ...pack.taxes.rules, ...pack.payroll.rules, ...pack.dsf.adjustments].map(toRuleDefinition);
  const set = new RuleSet(allRules);
  problems.push(...set.validate());
  const ids = new Set(set.ids());
  const knownVariables = new Set([...pack.variables, ...pack.payroll.variables, ...ids, "base", "base_imposable", "montant", "ca", "ca_annuel", "resultat_fiscal", "resultat_comptable"]);
  for (const r of allRules) {
    for (const dep of r.depends_on ?? []) {
      if (!ids.has(dep)) problems.push(`${r.id} : dépendance inconnue ${dep}`);
    }
    if (r.expr) {
      try {
        for (const v of referencedVariables(r.expr)) {
          if (!knownVariables.has(v) && !(r.depends_on ?? []).includes(v)) problems.push(`${r.id} : variable « ${v} » non déclarée (payroll.variables ou depends_on)`);
        }
      } catch (e) {
        problems.push(`${r.id} : expression invalide (${(e as Error).message})`);
      }
    }
  }
  for (const rate of pack.vat.rates) {
    if (!/^44[35]/.test(rate.collected_account) && !/^44/.test(rate.collected_account)) problems.push(`vat.rates.${rate.code} : compte de TVA facturée hors classe 44`);
  }
  if (pack.status === "PUBLISHED" && !pack.reviewed_by) problems.push("un pack PUBLISHED doit indiquer reviewed_by (expert-comptable du pays)");
  return problems;
}

export function packRules(pack: CountryPack): RuleSet {
  return new RuleSet([...pack.vat.rules, ...pack.taxes.rules, ...pack.payroll.rules, ...pack.dsf.adjustments].map(toRuleDefinition));
}

function toRuleDefinition(r: CountryPack["vat"]["rules"][number]): RuleDefinition {
  const value: RuleDefinition["value"] | undefined =
    r.value === undefined
      ? undefined
      : typeof r.value === "object"
        ? { kind: "bareme", tranches: r.value.tranches.map((t) => ({ rate: String(t.rate), ...(t.upTo !== undefined ? { upTo: String(t.upTo) } : {}) })) }
        : r.value;
  return {
    id: r.id,
    valid_from: r.valid_from,
    ...(r.label !== undefined ? { label: r.label } : {}),
    ...(r.expr !== undefined ? { expr: r.expr } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(r.valid_to !== undefined ? { valid_to: r.valid_to } : {}),
    ...(r.depends_on !== undefined ? { depends_on: r.depends_on } : {}),
    ...(r.source !== undefined ? { source: r.source } : {}),
  };
}

/** Taux de TVA applicable à une date pour un code. */
export function vatRate(pack: CountryPack, code: string, date: string) {
  const hit = pack.vat.rates.find((r) => r.code === code && r.valid_from <= date && (r.valid_to === undefined || date <= r.valid_to));
  if (!hit) throw new PackError(`Pack ${pack.code} : taux de TVA ${code} inconnu au ${date}`);
  return hit;
}
