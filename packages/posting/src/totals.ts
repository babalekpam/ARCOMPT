import { CURRENCY_DECIMALS, Money, sum } from "@arcompt/ledger";
import { vatRate, type CountryPack } from "@arcompt/country-packs";
import type { ComputedLine, DocumentTotals, EventLine, VatRounding, VatSummaryRow } from "./types.js";

export interface TotalsOptions {
  pack: CountryPack;
  date: string;
  currency: string;
  /** per_line (défaut) : TVA arrondie ligne à ligne ; total : TVA arrondie sur la base cumulée par code. */
  vatRounding?: VatRounding;
}

/** Nombre de décimales de la devise (XOF : 0, EUR : 2). */
export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency] ?? 2;
}

/**
 * Calcule HT, TVA et TTC d'un document à partir de ses lignes, avec le taux du
 * pack pays à la date du document. Les montants sont arrondis aux décimales de
 * la devise ; le TTC est toujours la somme exacte des HT et des TVA retenus, ce
 * qui garantit qu'une écriture bâtie sur ces totaux est équilibrée.
 */
export function computeDocumentTotals(lines: EventLine[], opts: TotalsOptions): DocumentTotals {
  const decimals = currencyDecimals(opts.currency);
  const rounding = opts.vatRounding ?? "per_line";

  const computed: ComputedLine[] = lines.map((l, index) => {
    const net = Money.parse(l.amount).roundTo(decimals);
    const rate = l.vatCode ? vatRate(opts.pack, l.vatCode, opts.date) : null;
    const rateText = rate ? String(rate.rate) : "0";
    const vat = rounding === "per_line" && rate ? net.mulRate(rateText).roundTo(decimals) : Money.zero();
    return {
      index,
      label: l.label ?? "",
      net,
      vatCode: l.vatCode ?? null,
      vatRate: rateText,
      vat,
      gross: net.add(vat),
      accountNumber: l.accountNumber ?? null,
      partnerId: l.partnerId ?? null,
      analyticCode: l.analyticCode ?? null,
    };
  });

  // Récapitulatif par code TVA (ordre d'apparition).
  const byCode = new Map<string, VatSummaryRow>();
  for (const c of computed) {
    if (!c.vatCode) continue;
    const r = vatRate(opts.pack, c.vatCode, opts.date);
    const row = byCode.get(c.vatCode) ?? { vatCode: c.vatCode, rate: String(r.rate), base: Money.zero(), vat: Money.zero(), collectedAccount: r.collected_account, deductibleAccount: r.deductible_account };
    row.base = row.base.add(c.net);
    row.vat = row.vat.add(c.vat);
    byCode.set(c.vatCode, row);
  }
  if (rounding === "total") {
    // TVA calculée une seule fois sur la base cumulée par code, puis répartie sur
    // les lignes (la dernière ligne du code absorbe l'écart d'arrondi).
    for (const row of byCode.values()) {
      row.vat = row.base.mulRate(row.rate).roundTo(decimals);
      const members = computed.filter((c) => c.vatCode === row.vatCode);
      let allocated = Money.zero();
      members.forEach((m, i) => {
        const share = i === members.length - 1 ? row.vat.sub(allocated) : m.net.mulRate(row.rate).roundTo(decimals);
        m.vat = share;
        m.gross = m.net.add(share);
        allocated = allocated.add(share);
      });
    }
  }

  const totalNet = sum(computed.map((c) => c.net));
  const totalVat = sum([...byCode.values()].map((r) => r.vat));
  return { lines: computed, byVatCode: [...byCode.values()], totalNet, totalVat, totalGross: totalNet.add(totalVat), currency: opts.currency, decimals };
}
