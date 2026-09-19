import { Money, sum } from "@arcompt/ledger";
import { packRules, type CountryPack } from "@arcompt/country-packs";
import type { Decimal } from "@arcompt/rules";
import { filingCalendar } from "./calendar.js";
import { TaxError, type IsComputation, type IsInstalment } from "./types.js";
import { decimalToMoney, moneyToDecimal } from "./vat.js";

export interface IsInput {
  pack: CountryPack;
  /** Date d'évaluation des règles (fin d'exercice en général). */
  date: string;
  fiscalResult: Money | string;
  turnover: Money | string;
  /** Nombre d'acomptes (défaut 4) ; les dates viennent du calendrier du pack (entrées trimestrielles « IS ») de l'année suivante. */
  instalments?: number;
  /** Année civile des acomptes (défaut : année de `date` + 1). */
  year?: number;
  currency?: string;
}

/**
 * Impôt sur les bénéfices et acomptes : `is.amount` (IS sur le résultat fiscal),
 * `imf.amount` (impôt minimum sur le chiffre d'affaires), `is.due` (le plus élevé),
 * répartis en acomptes égaux, le dernier absorbant l'arrondi.
 */
export function computeIsInstalments(input: IsInput): IsComputation {
  const rules = packRules(input.pack);
  const fiscalResult = Money.parse(input.fiscalResult);
  const turnover = Money.parse(input.turnover);
  const scope = { resultat_fiscal: moneyToDecimal(fiscalResult), ca_annuel: moneyToDecimal(turnover) };
  const evalMoney = (id: string): Money => {
    try {
      return decimalToMoney(rules.evaluate(id, input.date, scope).value as Decimal);
    } catch (e) {
      throw new TaxError("PACK_REQUIRED", `Règle ${id} indisponible dans le pack ${input.pack.code} : ${(e as Error).message}`);
    }
  };
  const isAmount = evalMoney("is.amount");
  const imfAmount = rules.ids().includes("imf.amount") ? evalMoney("imf.amount") : Money.zero();
  const due = rules.ids().includes("is.due") ? evalMoney("is.due") : isAmount.cmp(imfAmount) >= 0 ? isAmount : imfAmount;
  const count = input.instalments ?? 4;
  if (count < 1) throw new TaxError("INVALID_INPUT", "Nombre d'acomptes invalide");
  const year = input.year ?? Number(input.date.slice(0, 4)) + 1;
  const dueDates = filingCalendar(input.pack, year, { today: "0000-01-01" })
    .filter((d) => d.kind === "IS_INSTALMENT" && d.frequency === "QUARTERLY")
    .map((d) => d.dueDate);
  const instalments: IsInstalment[] = splitEqual(due, count).map((amount, i) => ({ n: i + 1, amount, dueDate: dueDates[i] ?? null }));
  return { fiscalResult, turnover, isAmount, imfAmount, due, instalments };
}

/** Répartit un montant en `n` parts entières (0 décimale), la dernière absorbant l'arrondi. */
export function splitEqual(total: Money, n: number): Money[] {
  const part = total.mulRate(`${(1 / n).toFixed(10)}`).roundTo(0);
  const parts = Array.from({ length: n - 1 }, () => part);
  parts.push(total.sub(sum(parts)));
  return parts;
}
