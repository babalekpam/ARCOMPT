// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { z } from "zod";
import { Money } from "@arcompt/ledger";

/**
 * Tarification dégressive d'un cabinet : le prix unitaire par dossier baisse
 * avec le nombre de dossiers actifs.
 *
 *  - VOLUME : tous les dossiers sont facturés au prix du palier atteint ;
 *  - TIERED : chaque palier facture ses propres dossiers (prix marginal).
 *
 * Les paliers sont triés par upTo croissant ; le dernier, sans upTo, couvre
 * l'au-delà. Sans palier, le prix unitaire fixe s'applique.
 */
export const DegressiveTierSchema = z.object({
  upTo: z.number().int().positive().optional(),
  price: z.union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().nonnegative()]).transform((v) => Money.parse(v).toString()),
});
export const DegressiveTiersSchema = z.array(DegressiveTierSchema);

export type DegressiveTier = z.infer<typeof DegressiveTierSchema>;
export type PricingMode = "VOLUME" | "TIERED";

export interface InvoiceLine {
  from: number;
  to: number;
  count: number;
  unitPrice: string;
  amount: string;
}

export interface DegressiveInvoice {
  dossiers: number;
  mode: PricingMode;
  /** Prix unitaire appliqué (VOLUME) ou moyen (TIERED, arrondi à 4 décimales) ; null sans dossier. */
  unitPrice: string | null;
  total: string;
  lines: InvoiceLine[];
}

/** Valide et normalise des paliers venus de la base (jsonb) ; lève si malformés. */
export function parseTiers(raw: unknown): DegressiveTier[] {
  const tiers = DegressiveTiersSchema.parse(raw ?? []);
  const sorted = [...tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  sorted.forEach((t, i) => {
    if (t.upTo === undefined && i !== sorted.length - 1) throw new Error("un seul palier sans upTo, en dernière position");
    if (i > 0 && t.upTo !== undefined && t.upTo <= (sorted[i - 1]!.upTo ?? Infinity)) throw new Error("paliers upTo strictement croissants attendus");
  });
  return sorted;
}

function times(price: Money, count: number): Money {
  return Money.fromMinor(price.minor * BigInt(count));
}

/** Prix unitaire du palier atteint pour `count` dossiers (mode VOLUME). */
export function unitPriceFor(count: number, tiers: DegressiveTier[], fallback: string): Money {
  const sorted = parseTiers(tiers);
  if (sorted.length === 0) return Money.parse(fallback);
  for (const t of sorted) {
    if (t.upTo === undefined || count <= t.upTo) return Money.parse(t.price);
  }
  return Money.parse(sorted[sorted.length - 1]!.price);
}

export function computeDegressiveInvoice(input: { dossiers: number; tiers: unknown; pricePerDossier: string; mode?: PricingMode; flatMonthly?: string | undefined }): DegressiveInvoice {
  if (!Number.isInteger(input.dossiers) || input.dossiers < 0) throw new Error(`nombre de dossiers invalide : ${input.dossiers}`);
  const mode = input.mode ?? "VOLUME";
  const n = input.dossiers;
  // Forfait mensuel unique (offre Cabinet) : le montant ne dépend pas du nombre de dossiers.
  if (input.flatMonthly !== undefined) {
    const flat = Money.parse(input.flatMonthly);
    return { dossiers: n, mode, unitPrice: flat.toString(), total: flat.toString(), lines: [{ from: 1, to: Math.max(n, 1), count: 1, unitPrice: flat.toString(), amount: flat.toString() }] };
  }
  const tiers = parseTiers(input.tiers);
  if (n === 0) return { dossiers: 0, mode, unitPrice: null, total: Money.zero().toString(), lines: [] };

  if (mode === "VOLUME" || tiers.length === 0) {
    const unit = unitPriceFor(n, tiers, input.pricePerDossier);
    const total = times(unit, n);
    return { dossiers: n, mode, unitPrice: unit.toString(), total: total.toString(), lines: [{ from: 1, to: n, count: n, unitPrice: unit.toString(), amount: total.toString() }] };
  }

  // TIERED : chaque palier facture les dossiers qu'il couvre.
  const lines: InvoiceLine[] = [];
  let total = Money.zero();
  let from = 1;
  for (const t of tiers) {
    if (from > n) break;
    const to = t.upTo === undefined ? n : Math.min(t.upTo, n);
    const count = to - from + 1;
    const unit = Money.parse(t.price);
    const amount = times(unit, count);
    lines.push({ from, to, count, unitPrice: unit.toString(), amount: amount.toString() });
    total = total.add(amount);
    from = to + 1;
  }
  const average = Money.fromMinor(total.minor / BigInt(n));
  return { dossiers: n, mode, unitPrice: average.toString(), total: total.toString(), lines };
}
