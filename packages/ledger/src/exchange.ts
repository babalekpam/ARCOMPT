// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { normalizeCurrency } from "./currency.js";
import { LedgerError } from "./errors.js";
import type { Ledger } from "./ledger.js";
import { Money } from "./money.js";
import type { RateProvider } from "./rates.js";
import type { Actor, ForeignPosition, Id, JournalEntry, JournalEntryInput } from "./types.js";

/**
 * Écarts de change SYSCOHADA révisé.
 *
 * Deux situations, deux traitements :
 *
 *  - **Écart réalisé** : une créance ou une dette en devise est réglée à un
 *    cours différent de celui de la facture. L'écart est définitif et passe en
 *    résultat financier — 676 « Pertes de change » ou 776 « Gains de change ».
 *
 *  - **Écart latent** : à la clôture, les créances et dettes en devise encore
 *    ouvertes sont converties au cours de clôture. La différence avec la
 *    contrevaleur historique n'est pas réalisée : elle passe par 478 « Écarts de
 *    conversion – Actif » (perte latente) ou 479 « Écarts de conversion –
 *    Passif » (gain latent). Ces écritures sont contrepassées à l'ouverture de
 *    l'exercice suivant, faute de quoi les soldes historiques seraient faussés.
 *
 * Conventions de cette unité :
 *   - un taux va toujours de la devise de la ligne vers la devise du dossier ;
 *   - aucun flottant n'intervient : `Money` et les taux en chaîne à 10 décimales.
 */

export const ACCOUNT_LOSS_REALISED = "676"; // Pertes de change financières
export const ACCOUNT_GAIN_REALISED = "776"; // Gains de change financiers
export const ACCOUNT_TRANSLATION_ASSET = "478"; // Écarts de conversion – Actif (perte latente)
export const ACCOUNT_TRANSLATION_LIABILITY = "479"; // Écarts de conversion – Passif (gain latent)

/** Sens de la position : une créance (actif) ou une dette (passif). */
export type PositionSide = "RECEIVABLE" | "PAYABLE";

export interface RealisedDifferenceInput {
  /** Montant réglé, exprimé dans la devise de la facture. */
  foreignAmount: Money | string;
  /** Taux retenu à la facture (historique). */
  invoiceRate: string;
  /** Taux du jour du règlement. */
  settlementRate: string;
  side: PositionSide;
}

export interface RealisedDifference {
  /** Contrevaleur historique du montant réglé. */
  historical: Money;
  /** Contrevaleur au cours du règlement. */
  settled: Money;
  /** Écart, toujours positif ; `kind` en donne le sens. */
  amount: Money;
  kind: "GAIN" | "LOSS" | "NONE";
  /** Compte SYSCOHADA de l'écart (null si aucun écart). */
  account: string | null;
}

/**
 * Écart de change réalisé sur le règlement d'une créance ou d'une dette.
 *
 * Créance : le cours monte, l'entreprise encaisse plus que prévu → gain.
 * Dette   : le cours monte, l'entreprise paie plus que prévu → perte.
 */
export function realisedDifference(input: RealisedDifferenceInput): RealisedDifference {
  const amount = Money.parse(input.foreignAmount);
  if (amount.isNegative()) throw new LedgerError("LINE_NEGATIVE", "Le montant réglé s'exprime en valeur absolue ; le sens vient de `side`");
  const historical = amount.mulRate(input.invoiceRate);
  const settled = amount.mulRate(input.settlementRate);
  const delta = settled.sub(historical);
  if (delta.isZero()) return { historical, settled, amount: Money.zero(), kind: "NONE", account: null };
  const favourable = input.side === "RECEIVABLE" ? delta.isPositive() : delta.isNegative();
  return {
    historical,
    settled,
    amount: delta.abs(),
    kind: favourable ? "GAIN" : "LOSS",
    account: favourable ? ACCOUNT_GAIN_REALISED : ACCOUNT_LOSS_REALISED,
  };
}

export interface RealisedEntryInput extends RealisedDifferenceInput {
  /** Compte de tiers réglé (411x, 401x…). */
  partnerAccountNumber: string;
  partnerId?: Id;
  /** Devise de la facture, pour l'intitulé et la traçabilité. */
  currency: string;
  date: string;
  journalCode?: string;
  reference?: string;
  label?: string;
  /** Comptes d'écart, si le plan du dossier les subdivise (6761, 7761…). */
  lossAccountNumber?: string;
  gainAccountNumber?: string;
}

export interface RealisedEntryPlan {
  difference: RealisedDifference;
  /** Null lorsque les deux cours coïncident : il n'y a rien à comptabiliser. */
  input: JournalEntryInput | null;
}

/**
 * Écriture d'écart de change réalisé.
 *
 * Elle est libellée dans la devise du dossier : l'écart n'est pas un montant en
 * devise, c'est la conséquence d'une variation de cours. Le compte de tiers est
 * soldé de la différence, la contrepartie va en 676 ou 776.
 *
 * Créance, gain : le compte client est débité (la contrevaleur encaissée
 * dépasse la contrevaleur historique), 776 crédité. Créance, perte : l'inverse.
 * Dette, gain : le compte fournisseur est débité, 776 crédité ; dette, perte :
 * l'inverse.
 */
export function planRealisedDifference(input: RealisedEntryInput): RealisedEntryPlan {
  const difference = realisedDifference(input);
  if (difference.kind === "NONE" || difference.account === null) return { difference, input: null };
  const currency = normalizeCurrency(input.currency);
  const gain = difference.kind === "GAIN";
  const resultAccount = gain ? (input.gainAccountNumber ?? ACCOUNT_GAIN_REALISED) : (input.lossAccountNumber ?? ACCOUNT_LOSS_REALISED);
  // Le compte de tiers porte l'écart au débit sur un gain, au crédit sur une
  // perte — dans les deux sens de position : c'est ce qui solde la
  // contrevaleur historique restée au bilan.
  const partnerSide = gain ? "debit" : "credit";
  const resultSide = gain ? "credit" : "debit";
  const amount = difference.amount.toString();
  const label = input.label ?? `Écart de change ${gain ? "favorable" : "défavorable"} sur règlement ${currency}`;
  return {
    difference,
    input: {
      journalCode: input.journalCode ?? "OD",
      date: input.date,
      ...(input.reference ? { reference: input.reference } : {}),
      label,
      source: "MANUAL",
      lines: [
        { accountNumber: input.partnerAccountNumber, [partnerSide]: amount, label, ...(input.partnerId ? { partnerId: input.partnerId } : {}) },
        { accountNumber: resultAccount, [resultSide]: amount, label },
      ],
    },
  };
}

/** Comptabilise l'écart réalisé. Renvoie null quand les deux cours coïncident. */
export async function postRealisedDifference(ledger: Ledger, actor: Actor, input: RealisedEntryInput): Promise<JournalEntry | null> {
  const plan = planRealisedDifference(input);
  return plan.input ? ledger.post(actor, plan.input) : null;
}

// ---------------------------------------------------------------------------
// Écarts latents : retranslation de fin de période
// ---------------------------------------------------------------------------

export interface RetranslationLine {
  accountNumber: string;
  accountLabel: string;
  partnerId: Id | null;
  currency: string;
  /** Solde en devise d'origine (débiteur positif, créditeur négatif). */
  foreignBalance: Money;
  /** Contrevaleur historique de ce solde, telle qu'elle figure dans les comptes. */
  historicalBalance: Money;
  /** Cours de clôture retenu et sa provenance. */
  closingRate: string;
  rateSource: string;
  /** Contrevaleur au cours de clôture. */
  closingBalance: Money;
  /** closingBalance − historicalBalance, signé. */
  difference: Money;
  /** 478 (perte latente) ou 479 (gain latent). */
  kind: "LATENT_LOSS" | "LATENT_GAIN";
}

export interface RetranslationPlan {
  date: string;
  baseCurrency: string;
  lines: RetranslationLine[];
  /** Total porté en 478 (perte latente). */
  totalAsset: Money;
  /** Total porté en 479 (gain latent). */
  totalLiability: Money;
  /** Écriture de clôture, null s'il n'y a aucun écart. */
  closing: JournalEntryInput | null;
  /** Contrepassation à l'ouverture de l'exercice suivant, null s'il n'y a rien. */
  opening: JournalEntryInput | null;
  /** Positions dont le cours de clôture est introuvable : à traiter à la main. */
  missingRates: Array<{ accountNumber: string; currency: string }>;
}

export interface RetranslationOptions {
  /** Date de clôture : les positions sont converties à ce cours. */
  date: string;
  /** Date de la contrepassation, en principe le premier jour de l'exercice suivant. */
  reversalDate: string;
  /** Début de la période d'accumulation des positions (début d'exercice). */
  from: string;
  /**
   * Comptes retranslatés. Par défaut les comptes monétaires de tiers et de
   * trésorerie (classes 4 et 5) : eux seuls portent un risque de change latent.
   * Les immobilisations et les stocks restent au coût historique.
   */
  accountPrefixes?: string[];
  journalCode?: string;
  label?: string;
  assetAccountNumber?: string;
  liabilityAccountNumber?: string;
}

const DEFAULT_MONETARY_PREFIXES = ["4", "5"];

/**
 * Prépare la retranslation des positions en devise encore ouvertes.
 *
 * L'écriture de clôture porte, par compte et par devise, l'écart entre la
 * contrevaleur historique et la contrevaleur au cours de clôture ; la
 * contrepartie est 478 pour une perte latente, 479 pour un gain latent.
 * L'écriture d'ouverture la contrepasse à la date demandée : sans elle, la
 * position resterait convertie deux fois.
 */
export async function planRetranslation(
  ledger: Ledger,
  tenantId: Id,
  rates: RateProvider,
  opts: RetranslationOptions,
): Promise<RetranslationPlan> {
  const baseCurrency = await ledger.baseCurrency(tenantId);
  const prefixes = opts.accountPrefixes ?? DEFAULT_MONETARY_PREFIXES;
  const positions = await ledger.foreignPositions(tenantId, { from: opts.from, to: opts.date, accountPrefixes: prefixes });
  const lines: RetranslationLine[] = [];
  const missingRates: RetranslationPlan["missingRates"] = [];

  for (const p of positions) {
    const foreignBalance = p.foreignDebit.sub(p.foreignCredit);
    const historicalBalance = p.baseDebit.sub(p.baseCredit);
    if (foreignBalance.isZero()) continue; // position dénouée : plus de risque de change
    const quote = await rates.getRate(tenantId, p.currency, baseCurrency, opts.date);
    if (!quote) {
      missingRates.push({ accountNumber: p.accountNumber, currency: p.currency });
      continue;
    }
    const closingBalance = foreignBalance.mulRate(quote.rate);
    const difference = closingBalance.sub(historicalBalance);
    if (difference.isZero()) continue;
    // Un solde débiteur (créance) qui perd de la valeur, comme un solde
    // créditeur (dette) qui en gagne, appauvrit l'entreprise : perte latente.
    const latentLoss = difference.isNegative();
    lines.push({
      accountNumber: p.accountNumber,
      accountLabel: p.accountLabel,
      partnerId: p.partnerId,
      currency: p.currency,
      foreignBalance,
      historicalBalance,
      closingRate: quote.rate,
      rateSource: quote.inverted ? `${quote.source}/INVERSE` : quote.source,
      closingBalance,
      difference,
      kind: latentLoss ? "LATENT_LOSS" : "LATENT_GAIN",
    });
  }

  const totalAsset = lines.filter((l) => l.kind === "LATENT_LOSS").reduce((acc, l) => acc.add(l.difference.abs()), Money.zero());
  const totalLiability = lines.filter((l) => l.kind === "LATENT_GAIN").reduce((acc, l) => acc.add(l.difference), Money.zero());

  if (lines.length === 0) {
    return { date: opts.date, baseCurrency, lines, totalAsset, totalLiability, closing: null, opening: null, missingRates };
  }

  const journalCode = opts.journalCode ?? "OD";
  const label = opts.label ?? `Écarts de conversion au ${opts.date}`;
  const assetAccount = opts.assetAccountNumber ?? ACCOUNT_TRANSLATION_ASSET;
  const liabilityAccount = opts.liabilityAccountNumber ?? ACCOUNT_TRANSLATION_LIABILITY;

  // Chaque position est ajustée sur son propre compte ; la contrepartie globale
  // va en 478 ou 479, dans la devise du dossier.
  const closingLines: JournalEntryInput["lines"] = [];
  for (const l of lines) {
    const side = l.difference.isPositive() ? "debit" : "credit";
    closingLines.push({
      accountNumber: l.accountNumber,
      [side]: l.difference.abs().toString(),
      label: `${l.currency} au cours de ${l.closingRate}`,
      ...(l.partnerId ? { partnerId: l.partnerId } : {}),
    });
  }
  if (!totalAsset.isZero()) closingLines.push({ accountNumber: assetAccount, debit: totalAsset.toString(), label: "Perte latente de change" });
  if (!totalLiability.isZero()) closingLines.push({ accountNumber: liabilityAccount, credit: totalLiability.toString(), label: "Gain latent de change" });

  const closing: JournalEntryInput = { journalCode, date: opts.date, label, source: "CLOSING", lines: closingLines };
  const opening: JournalEntryInput = {
    journalCode,
    date: opts.reversalDate,
    label: `Contrepassation des écarts de conversion du ${opts.date}`,
    source: "CLOSING",
    lines: closingLines.map((l) => ({
      accountNumber: l.accountNumber,
      ...(l.debit !== undefined ? { credit: l.debit } : {}),
      ...(l.credit !== undefined ? { debit: l.credit } : {}),
      ...(l.label !== undefined ? { label: l.label } : {}),
      ...(l.partnerId !== undefined ? { partnerId: l.partnerId } : {}),
    })),
  };

  return { date: opts.date, baseCurrency, lines, totalAsset, totalLiability, closing, opening, missingRates };
}

/**
 * Comptabilise la retranslation : l'écriture de clôture et sa contrepassation à
 * l'ouverture. La contrepassation n'est passée que si sa période est ouverte ;
 * sinon l'appelant la repassera lorsque l'exercice suivant existera.
 */
export async function postRetranslation(
  ledger: Ledger,
  actor: Actor,
  rates: RateProvider,
  opts: RetranslationOptions & { postOpening?: boolean },
): Promise<{ plan: RetranslationPlan; closing: JournalEntry | null; opening: JournalEntry | null }> {
  const plan = await planRetranslation(ledger, actor.tenantId, rates, opts);
  if (!plan.closing) return { plan, closing: null, opening: null };
  const closing = await ledger.post(actor, plan.closing);
  let opening: JournalEntry | null = null;
  if (opts.postOpening !== false && plan.opening) opening = await ledger.post(actor, plan.opening);
  return { plan, closing, opening };
}

/** Solde d'une position, en devise d'origine puis en contrevaleur historique. */
export function positionBalance(p: ForeignPosition): { foreign: Money; historical: Money } {
  return { foreign: p.foreignDebit.sub(p.foreignCredit), historical: p.baseDebit.sub(p.baseCredit) };
}
