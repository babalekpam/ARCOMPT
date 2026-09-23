// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Money, parseRate, RATE_SCALE, sum } from "@arcompt/ledger";
import { Decimal } from "@arcompt/rules";
import { packRules, type CountryPack } from "@arcompt/country-packs";
import { DEFAULT_VAT_ACCOUNTS, type VatAccounts, type VatCodeAmount, type VatLine, type VatReturnComputation } from "./types.js";

export interface VatReturnInput {
  periodFrom: string;
  periodTo: string;
  /** Lignes des comptes 443x / 445x sur la période (agrégées ou brutes). */
  lines: VatLine[];
  /** Crédit de TVA reporté de la déclaration précédente. */
  previousCredit?: Money | string;
  /** Pack pays : taux (reconstitution des bases) et règle `vat.due`. */
  pack?: CountryPack;
  accounts?: Partial<VatAccounts>;
}

const NO_CODE = "SANS_CODE";

/**
 * Déclaration de TVA : fonction pure. TVA collectée = solde créditeur des
 * comptes 443x, TVA déductible = solde débiteur des comptes 445x, par code
 * de TVA ; net = collectée − déductible (règle `vat.due` du pack si présente) ;
 * le crédit antérieur s'impute sur le net.
 */
export function computeVatReturn(input: VatReturnInput): VatReturnComputation {
  const accounts = { ...DEFAULT_VAT_ACCOUNTS, ...input.accounts };
  const collectedByCode = new Map<string, Money>();
  const deductibleByCode = new Map<string, Money>();
  for (const l of input.lines) {
    const code = l.vatCode ?? NO_CODE;
    if (l.accountNumber.startsWith(accounts.collected)) {
      collectedByCode.set(code, (collectedByCode.get(code) ?? Money.zero()).add(l.credit.sub(l.debit)));
    } else if (l.accountNumber.startsWith(accounts.deductible)) {
      deductibleByCode.set(code, (deductibleByCode.get(code) ?? Money.zero()).add(l.debit.sub(l.credit)));
    }
  }
  const toRows = (map: Map<string, Money>): VatCodeAmount[] =>
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([vatCode, amount]) => {
        const rate = input.pack ? rateFor(input.pack, vatCode, input.periodTo) : null;
        return { vatCode, rate, base: rate && !rate.isZero ? baseFromAmount(amount, rate.value) : null, amount };
      })
      .map((r) => ({ ...r, rate: r.rate ? r.rate.value : null }));
  const collected = toRows(collectedByCode);
  const deductible = toRows(deductibleByCode);
  const totalCollected = sum(collected.map((r) => r.amount));
  const totalDeductible = sum(deductible.map((r) => r.amount));
  const net = netVat(input.pack, totalCollected, totalDeductible, input.periodTo);
  const previousCredit = Money.parse(input.previousCredit ?? "0");
  const afterCredit = net.sub(previousCredit);
  return {
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    collected,
    deductible,
    totalCollected,
    totalDeductible,
    net,
    previousCredit,
    amountDue: afterCredit.isPositive() ? afterCredit : Money.zero(),
    creditCarried: afterCredit.isNegative() ? afterCredit.neg() : Money.zero(),
  };
}

function rateFor(pack: CountryPack, vatCode: string, date: string): { value: string; isZero: boolean } | null {
  const hit = pack.vat.rates.find((r) => r.code === vatCode && r.valid_from <= date && (r.valid_to === undefined || date <= r.valid_to));
  if (!hit) return null;
  const value = String(hit.rate);
  return { value, isZero: parseRate(value) === 0n };
}

/** Base HT = TVA / taux, arrondie à 4 décimales. */
function baseFromAmount(amount: Money, rate: string): Money {
  const r = parseRate(rate);
  if (r === 0n) return Money.zero();
  const factor = 10n ** BigInt(RATE_SCALE);
  const num = amount.minor * factor;
  const q = num / r;
  const rem = num % r;
  const rounded = (rem < 0n ? -rem : rem) * 2n >= r ? (num < 0n ? q - 1n : q + 1n) : q;
  return Money.fromMinor(rounded);
}

/** Net via la règle `vat.due` du pack quand elle existe (traçabilité), sinon soustraction directe. */
function netVat(pack: CountryPack | undefined, collected: Money, deductible: Money, date: string): Money {
  if (pack && pack.vat.rules.some((r) => r.id === "vat.due")) {
    const result = packRules(pack).evaluate("vat.due", date, { tva_collectee: Decimal.of(collected.toString()), tva_deductible: Decimal.of(deductible.toString()) });
    return decimalToMoney(result.value as Decimal);
  }
  return collected.sub(deductible);
}

/** Decimal (10 décimales) → Money (4 décimales), arrondi arithmétique. */
export function decimalToMoney(d: Decimal): Money {
  return Money.fromMinor(d.round(4).raw / 10n ** 6n);
}

export function moneyToDecimal(m: Money): Decimal {
  return Decimal.of(m.toString());
}
