import { beforeEach, describe, expect, it } from "vitest";
import { staticCurrencyResolver } from "./currency.js";
import { planRealisedDifference, planRetranslation, postRealisedDifference, postRetranslation, realisedDifference } from "./exchange.js";
import { canonicalEntryPayload, computeEntryHash } from "./hash.js";
import { Ledger } from "./ledger.js";
import { MemoryStore } from "./memory-store.js";
import { composeRates, invertRate, Money } from "./money.js";
import { StaticRateProvider } from "./rates.js";
import type { Actor, FiscalYear, JournalEntryInput } from "./types.js";

const CI = "11111111-1111-4111-8111-111111111111"; // dossier ivoirien, XOF
const CM = "22222222-2222-4222-8222-222222222222"; // dossier camerounais, XAF
const NO_CURRENCY = "33333333-3333-4333-8333-333333333333"; // dossier sans devise déclarée

const actorCI: Actor = { userId: "u1", tenantId: CI };
const actorCM: Actor = { userId: "u2", tenantId: CM };
const actorNC: Actor = { userId: "u3", tenantId: NO_CURRENCY };

const CHART = [
  { number: "401", label: "Fournisseurs", lettrable: true },
  { number: "411", label: "Clients", lettrable: true },
  { number: "478", label: "Écarts de conversion – Actif" },
  { number: "479", label: "Écarts de conversion – Passif" },
  { number: "521", label: "Banques locales" },
  { number: "601", label: "Achats de marchandises" },
  { number: "676", label: "Pertes de change financières" },
  { number: "706", label: "Services vendus" },
  { number: "776", label: "Gains de change financiers" },
];

// 1 EUR = 655,957 XOF (parité fixe) ; le franc guinéen flotte.
const RATES = new StaticRateProvider([
  { from: "GNF", to: "XOF", rate: "0.0700000000", validFrom: "2025-01-01", source: "BCEAO", sourceRef: "Bulletin BCEAO 2025-01" },
  { from: "GNF", to: "XOF", rate: "0.0680000000", validFrom: "2025-06-01", source: "BCEAO", sourceRef: "Bulletin BCEAO 2025-06" },
  { from: "USD", to: "XAF", rate: "600.0000000000", validFrom: "2025-01-01", source: "BEAC", sourceRef: "Bulletin BEAC 2025-01" },
]);

let store: MemoryStore;
let fyCI: FiscalYear;

function ledgerFor(currencies: Record<string, string>, opts: { rates?: StaticRateProvider } = {}): Ledger {
  return new Ledger(store, {
    baseCurrency: "XOF", // repli de processus, volontairement « faux » pour le dossier camerounais
    currencyResolver: staticCurrencyResolver(currencies),
    ...(opts.rates ? { rates: opts.rates } : {}),
  });
}

const ALL = { [CI]: "XOF", [CM]: "XAF" };

beforeEach(async () => {
  store = new MemoryStore();
  for (const t of [CI, CM, NO_CURRENCY]) {
    store.seedAccounts(t, CHART);
    store.seedJournals(t);
    await store.createFiscalYear(t, { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
    await store.createFiscalYear(t, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
  }
  fyCI = (await store.getFiscalYearByCode(CI, "2025"))!;
});

describe("devise par dossier", () => {
  it("chaque dossier est tenu dans sa propre devise, pas dans celle du processus", async () => {
    const ledger = ledgerFor(ALL);
    expect(await ledger.baseCurrency(CI)).toBe("XOF");
    // Le dossier camerounais est en XAF alors que le processus est configuré en XOF.
    expect(await ledger.baseCurrency(CM)).toBe("XAF");
  });

  it("retombe sur la devise configurée pour un dossier qui n'en déclare aucune", async () => {
    const ledger = ledgerFor(ALL);
    expect(await ledger.baseCurrency(NO_CURRENCY)).toBe("XOF");
    const e = await ledger.post(actorNC, {
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1000", partnerId: "p" },
        { accountNumber: "706", credit: "1000" },
      ],
    });
    expect(e.lines[0]!.currency).toBe("XOF");
  });

  it("la balance annonce la devise du dossier", async () => {
    const ledger = ledgerFor(ALL);
    expect((await ledger.trialBalance(CI, { fiscalYearCode: "2025" })).currency).toBe("XOF");
    expect((await ledger.trialBalance(CM, { fiscalYearCode: "2025" })).currency).toBe("XAF");
  });

  it("une ligne en XAF passe sans taux dans un dossier XAF, et en exige un dans un dossier XOF", async () => {
    const ledger = ledgerFor(ALL);
    const entry = (tenantCurrency: string): JournalEntryInput => ({
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1000", currency: tenantCurrency, partnerId: "p" },
        { accountNumber: "706", credit: "1000", currency: tenantCurrency },
      ],
    });
    await expect(ledger.post(actorCM, entry("XAF"))).resolves.toMatchObject({ status: "VALIDATED" });
    await expect(ledger.post(actorCI, entry("XAF"))).rejects.toMatchObject({ code: "RATE_REQUIRED" });
  });

  it("le résolveur ne consulte la source qu'une fois par dossier tant que le cache est chaud", async () => {
    let reads = 0;
    const counting = {
      async currencyFor(tenantId: string) {
        reads += 1;
        return tenantId === CM ? "XAF" : "XOF";
      },
    };
    const ledger = new Ledger(store, { baseCurrency: "XOF", currencyResolver: counting });
    await ledger.baseCurrency(CI);
    await ledger.baseCurrency(CI);
    // Le moteur délègue sans mémoriser : c'est le résolveur partagé du serveur
    // qui porte le cache, pour qu'il survive à la requête.
    expect(reads).toBe(2);
  });
});

describe("conversion à la comptabilisation", () => {
  const eurSale: JournalEntryInput = {
    journalCode: "VT",
    date: "2025-03-15",
    reference: "FAC-EUR-1",
    label: "Facture export",
    source: "INVOICE",
    lines: [
      { accountNumber: "411", debit: "1000", currency: "EUR", partnerId: "p-export" },
      { accountNumber: "706", credit: "1000", currency: "EUR" },
    ],
  };

  it("conserve le montant d'origine et le montant converti", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const e = await ledger.post(actorCI, eurSale);
    const client = e.lines[0]!;
    expect(client.currency).toBe("EUR");
    expect(client.debit.toString()).toBe("1000.0000"); // ce que dit la pièce
    expect(client.rate).toBe("655.9570000000"); // parité fixe UEMOA
    expect(client.rateSource).toBe("FIXED");
    expect(client.debitBase.toString()).toBe("655957.0000"); // ce qui entre au bilan
    expect(e.lines[1]!.creditBase.toString()).toBe("655957.0000");
  });

  it("refuse une ligne en devise étrangère sans taux utilisable plutôt que de la traiter comme de la devise du dossier", async () => {
    const sansTaux = new Ledger(store, { baseCurrency: "XOF", currencyResolver: staticCurrencyResolver(ALL) });
    await expect(sansTaux.post(actorCI, eurSale)).rejects.toMatchObject({ code: "RATE_REQUIRED" });

    const ledger = ledgerFor(ALL, { rates: RATES });
    const mauvaisTaux: JournalEntryInput = { ...eurSale, lines: eurSale.lines.map((l) => ({ ...l, rate: "0" })) };
    await expect(ledger.post(actorCI, mauvaisTaux)).rejects.toMatchObject({ code: "RATE_INVALID" });
  });

  it("refuse un taux posé sur une ligne déjà dans la devise du dossier", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const input: JournalEntryInput = {
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1000", currency: "XOF", rate: "655.957", partnerId: "p" },
        { accountNumber: "706", credit: "1000" },
      ],
    };
    await expect(ledger.post(actorCI, input)).rejects.toMatchObject({ code: "RATE_NOT_APPLICABLE" });
  });

  it("le taux de la pièce l'emporte sur celui de la table", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const input: JournalEntryInput = {
      journalCode: "AC",
      date: "2025-03-15",
      label: "Achat Conakry",
      source: "PURCHASE",
      lines: [
        { accountNumber: "601", debit: "100000", currency: "GNF", rate: "0.0725", rateSource: "MANUAL" },
        { accountNumber: "401", credit: "100000", currency: "GNF", rate: "0.0725", partnerId: "p-gn" },
      ],
    };
    const e = await ledger.post(actorCI, input);
    expect(e.lines[0]!.rate).toBe("0.0725");
    expect(e.lines[0]!.rateSource).toBe("MANUAL");
    expect(e.lines[0]!.debitBase.toString()).toBe("7250.0000");
  });

  it("retient le taux en vigueur à la date de l'écriture", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const gnf = (date: string): JournalEntryInput => ({
      journalCode: "AC",
      date,
      label: "Achat Conakry",
      source: "PURCHASE",
      lines: [
        { accountNumber: "601", debit: "100000", currency: "GNF" },
        { accountNumber: "401", credit: "100000", currency: "GNF", partnerId: "p-gn" },
      ],
    });
    expect((await ledger.post(actorCI, gnf("2025-03-15"))).lines[0]!.debitBase.toString()).toBe("7000.0000");
    expect((await ledger.post(actorCI, gnf("2025-07-15"))).lines[0]!.debitBase.toString()).toBe("6800.0000");
  });

  it("l'équilibre se juge sur les montants convertis", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    // Un euro contre un franc : les nombres coïncident, les valeurs non.
    const faussementEquilibree: JournalEntryInput = {
      journalCode: "OD",
      date: "2025-03-15",
      label: "Euro contre franc",
      source: "MANUAL",
      lines: [
        { accountNumber: "521", debit: "1000", currency: "EUR" },
        { accountNumber: "706", credit: "1000", currency: "XOF" },
      ],
    };
    await expect(ledger.post(actorCI, faussementEquilibree)).rejects.toMatchObject({ code: "UNBALANCED" });

    // Réellement équilibrée : 1 000 EUR encaissés contre 655 957 XOF de produit.
    const vraimentEquilibree: JournalEntryInput = {
      journalCode: "OD",
      date: "2025-03-15",
      label: "Encaissement export",
      source: "MANUAL",
      lines: [
        { accountNumber: "521", debit: "1000", currency: "EUR" },
        { accountNumber: "706", credit: "655957", currency: "XOF" },
      ],
    };
    await expect(ledger.post(actorCI, vraimentEquilibree)).resolves.toMatchObject({ status: "VALIDATED" });
  });

  it("la balance additionne les contrevaleurs, jamais les montants d'origine", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    await ledger.post(actorCI, eurSale);
    const tb = await ledger.trialBalance(CI, { fiscalYearCode: fyCI.code });
    const client = tb.rows.find((r) => r.accountNumber === "411")!;
    expect(client.debit.toString()).toBe("655957.0000");
    expect(tb.totalDebit.eq(tb.totalCredit)).toBe(true);
    expect(tb.currency).toBe("XOF");
  });

  it("refuse une conversion qui ramène le montant à zéro", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const input: JournalEntryInput = {
      journalCode: "OD",
      date: "2025-03-15",
      label: "Poussière",
      source: "MANUAL",
      lines: [
        { accountNumber: "601", debit: "0.0001", currency: "GNF", rate: "0.0000001" },
        { accountNumber: "401", credit: "0.0001", currency: "GNF", rate: "0.0000001", partnerId: "p" },
      ],
    };
    await expect(ledger.post(actorCI, input)).rejects.toMatchObject({ code: "CONVERSION_UNDERFLOW" });
  });

  it("la contrepassation reprend le taux d'origine et ne crée pas d'écart", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const e = await ledger.post(actorCI, eurSale);
    const r = await ledger.reverse(actorCI, e.id, { date: "2025-04-01" });
    expect(r.lines[0]!.rate).toBe(e.lines[0]!.rate);
    expect(r.lines[0]!.creditBase.toString()).toBe(e.lines[0]!.debitBase.toString());
    const tb = await ledger.trialBalance(CI, { fiscalYearCode: fyCI.code });
    expect(tb.rows.find((r2) => r2.accountNumber === "411")!.debit.sub(tb.rows.find((r2) => r2.accountNumber === "411")!.credit).isZero()).toBe(true);
  });
});

describe("chaînage par hash", () => {
  it("une écriture monodevise garde exactement le hash d'avant la multidevise", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const e = await ledger.post(actorCI, {
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture locale",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1000", partnerId: "p" },
        { accountNumber: "706", credit: "1000" },
      ],
    });
    // La sérialisation canonique ne comporte pas de montant converti : les
    // chaînes déjà scellées restent vérifiables.
    expect(canonicalEntryPayload(e)).not.toContain('"db"');
    expect(await ledger.verifyChain(CI, "VT")).toMatchObject({ ok: true });
  });

  it("une écriture en devise scelle aussi le montant converti", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const e = await ledger.post(actorCI, {
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture export",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1000", currency: "EUR", partnerId: "p" },
        { accountNumber: "706", credit: "1000", currency: "EUR" },
      ],
    });
    expect(canonicalEntryPayload(e)).toContain('"db":"655957.0000"');
    const falsifie = { ...e, lines: e.lines.map((l, i) => (i === 0 ? { ...l, debitBase: Money.parse("1") } : l)) };
    expect(computeEntryHash(falsifie, e.prevHash)).not.toBe(e.hash);
  });
});

describe("taux", () => {
  it("inverse un taux sans jamais passer par un flottant", () => {
    expect(invertRate("655.957")).toBe("0.0015244902");
    expect(invertRate("2")).toBe("0.5000000000");
    // Un aller-retour sur une parité non décimale n'est pas neutre : l'inverse
    // est arrondi à 10 décimales. C'est pourquoi les deux sens de chaque parité
    // fixe sont stockés, plutôt que calculés à la volée.
    expect(composeRates("2", "0.5")).toBe("1.0000000000");
    expect(composeRates("655.957", invertRate("655.957"))).toBe("1.0000000181");
  });

  it("sert les parités fixes de la zone franc sans qu'on les saisisse", async () => {
    const q = await RATES.getRate(CI, "EUR", "XOF", "2025-03-15");
    expect(q).toMatchObject({ rate: "655.9570000000", source: "FIXED", inverted: false });
    const inverse = await RATES.getRate(CI, "XOF", "EUR", "2025-03-15");
    expect(inverse).toMatchObject({ rate: "0.0015244902", source: "FIXED" });
    // XOF et XAF partagent la parité : ils s'échangent à l'unité.
    expect((await RATES.getRate(CI, "XAF", "XOF", "2025-03-15"))?.rate).toBe("1.0000000000");
  });

  it("inverse la paire opposée faute de mieux, et le signale", async () => {
    const q = await RATES.getRate(CI, "XOF", "GNF", "2025-03-15");
    expect(q).toMatchObject({ inverted: true, rate: invertRate("0.07") });
  });

  it("ne renvoie rien pour une paire inconnue", async () => {
    expect(await RATES.getRate(CI, "CDF", "XOF", "2025-03-15")).toBeNull();
  });
});

describe("écarts de change réalisés", () => {
  it("une créance encaissée à un cours plus élevé produit un gain", () => {
    const d = realisedDifference({ foreignAmount: "1000", invoiceRate: "650", settlementRate: "660", side: "RECEIVABLE" });
    expect(d).toMatchObject({ kind: "GAIN", account: "776" });
    expect(d.amount.toString()).toBe("10000.0000");
    expect(d.historical.toString()).toBe("650000.0000");
    expect(d.settled.toString()).toBe("660000.0000");
  });

  it("la même variation sur une dette produit une perte", () => {
    const d = realisedDifference({ foreignAmount: "1000", invoiceRate: "650", settlementRate: "660", side: "PAYABLE" });
    expect(d).toMatchObject({ kind: "LOSS", account: "676" });
    expect(d.amount.toString()).toBe("10000.0000");
  });

  it("deux cours identiques ne produisent aucune écriture", () => {
    const plan = planRealisedDifference({
      foreignAmount: "1000",
      invoiceRate: "655.957",
      settlementRate: "655.957",
      side: "RECEIVABLE",
      partnerAccountNumber: "411",
      currency: "EUR",
      date: "2025-06-30",
    });
    expect(plan.difference.kind).toBe("NONE");
    expect(plan.input).toBeNull();
  });

  it("comptabilise le gain sur créance : 411 au débit, 776 au crédit", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const e = await postRealisedDifference(ledger, actorCI, {
      foreignAmount: "1000",
      invoiceRate: "650",
      settlementRate: "660",
      side: "RECEIVABLE",
      partnerAccountNumber: "411",
      partnerId: "p-export",
      currency: "EUR",
      date: "2025-06-30",
      reference: "FAC-EUR-1",
    });
    expect(e).not.toBeNull();
    expect(e!.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["411", "10000.0000", "0.0000"],
      ["776", "0.0000", "10000.0000"],
    ]);
    // L'écart est un montant de la devise du dossier : aucune conversion.
    expect(e!.lines.every((l) => l.currency === "XOF" && l.rate === null)).toBe(true);
  });

  it("comptabilise la perte sur dette : 401 au crédit, 676 au débit", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    const e = await postRealisedDifference(ledger, actorCI, {
      foreignAmount: "1000",
      invoiceRate: "650",
      settlementRate: "660",
      side: "PAYABLE",
      partnerAccountNumber: "401",
      partnerId: "p-fr",
      currency: "EUR",
      date: "2025-06-30",
    });
    expect(e!.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["401", "0.0000", "10000.0000"],
      ["676", "10000.0000", "0.0000"],
    ]);
  });
});

describe("écarts de conversion latents (retranslation)", () => {
  /** Une créance de 1 000 EUR restée ouverte, comptabilisée à 650 (cours historique). */
  async function creanceOuverte(ledger: Ledger): Promise<void> {
    await ledger.post(actorCI, {
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture export",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1000", currency: "EUR", rate: "650", partnerId: "p-export" },
        { accountNumber: "706", credit: "650000" },
      ],
    });
  }

  it("porte la perte latente en 478 et la contrepasse à l'ouverture", async () => {
    // Cours de clôture inférieur au cours historique : la créance vaut moins.
    const rates = new StaticRateProvider([{ from: "EUR", to: "XOF", rate: "640.0000000000", validFrom: "2025-12-31", source: "BCEAO", sourceRef: "Clôture 2025" }]);
    const ledger = ledgerFor(ALL, { rates });
    await creanceOuverte(ledger);

    const { plan, closing, opening } = await postRetranslation(ledger, actorCI, rates, {
      from: "2025-01-01",
      date: "2025-12-31",
      reversalDate: "2026-01-01",
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ accountNumber: "411", currency: "EUR", kind: "LATENT_LOSS", closingRate: "640.0000000000" });
    expect(plan.lines[0]!.difference.toString()).toBe("-10000.0000");
    expect(plan.totalAsset.toString()).toBe("10000.0000");

    expect(closing!.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["411", "0.0000", "10000.0000"],
      ["478", "10000.0000", "0.0000"],
    ]);
    // Sans contrepassation, la créance resterait convertie deux fois.
    expect(opening!.date).toBe("2026-01-01");
    expect(opening!.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["411", "10000.0000", "0.0000"],
      ["478", "0.0000", "10000.0000"],
    ]);
  });

  it("porte le gain latent en 479", async () => {
    const rates = new StaticRateProvider([{ from: "EUR", to: "XOF", rate: "670.0000000000", validFrom: "2025-12-31", source: "BCEAO", sourceRef: "Clôture 2025" }]);
    const ledger = ledgerFor(ALL, { rates });
    await creanceOuverte(ledger);
    const { plan, closing } = await postRetranslation(ledger, actorCI, rates, { from: "2025-01-01", date: "2025-12-31", reversalDate: "2026-01-01" });
    expect(plan.lines[0]).toMatchObject({ kind: "LATENT_GAIN" });
    expect(plan.totalLiability.toString()).toBe("20000.0000");
    expect(closing!.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["411", "20000.0000", "0.0000"],
      ["479", "0.0000", "20000.0000"],
    ]);
  });

  it("ignore une position dénouée et une position au cours inchangé", async () => {
    const rates = new StaticRateProvider([{ from: "EUR", to: "XOF", rate: "650.0000000000", validFrom: "2025-12-31", source: "BCEAO", sourceRef: "Clôture 2025" }]);
    const ledger = ledgerFor(ALL, { rates });
    await creanceOuverte(ledger);
    // Cours de clôture identique au cours historique : rien à constater.
    const inchange = await planRetranslation(ledger, CI, rates, { from: "2025-01-01", date: "2025-12-31", reversalDate: "2026-01-01" });
    expect(inchange.lines).toEqual([]);
    expect(inchange.closing).toBeNull();

    // Encaissement au même cours : la position est dénouée.
    await ledger.post(actorCI, {
      journalCode: "BQ",
      date: "2025-11-30",
      label: "Encaissement export",
      source: "BANK",
      lines: [
        { accountNumber: "521", debit: "650000" },
        { accountNumber: "411", credit: "1000", currency: "EUR", rate: "650", partnerId: "p-export" },
      ],
    });
    const autres = new StaticRateProvider([{ from: "EUR", to: "XOF", rate: "700.0000000000", validFrom: "2025-12-31", source: "BCEAO", sourceRef: "Clôture 2025" }]);
    const denoue = await planRetranslation(ledger, CI, autres, { from: "2025-01-01", date: "2025-12-31", reversalDate: "2026-01-01" });
    expect(denoue.lines).toEqual([]);
  });

  it("signale les positions dont le cours de clôture est introuvable plutôt que de les convertir au hasard", async () => {
    const ledger = ledgerFor(ALL, { rates: RATES });
    await ledger.post(actorCI, {
      journalCode: "AC",
      date: "2025-03-15",
      label: "Achat Conakry",
      source: "PURCHASE",
      lines: [
        { accountNumber: "601", debit: "100000", currency: "GNF", rate: "0.07" },
        { accountNumber: "401", credit: "100000", currency: "GNF", rate: "0.07", partnerId: "p-gn" },
      ],
    });
    const vide = new StaticRateProvider([], { withFixedParities: false });
    const plan = await planRetranslation(ledger, CI, vide, { from: "2025-01-01", date: "2025-12-31", reversalDate: "2026-01-01" });
    expect(plan.missingRates).toEqual([{ accountNumber: "401", currency: "GNF" }]);
    expect(plan.closing).toBeNull();
  });

  it("ne retranslate que les comptes monétaires : le compte de charges en devise reste au coût historique", async () => {
    const rates = new StaticRateProvider([{ from: "GNF", to: "XOF", rate: "0.0600000000", validFrom: "2025-12-31", source: "BCEAO", sourceRef: "Clôture 2025" }]);
    const ledger = ledgerFor(ALL, { rates });
    await ledger.post(actorCI, {
      journalCode: "AC",
      date: "2025-03-15",
      label: "Achat Conakry",
      source: "PURCHASE",
      lines: [
        { accountNumber: "601", debit: "100000", currency: "GNF", rate: "0.07" },
        { accountNumber: "401", credit: "100000", currency: "GNF", rate: "0.07", partnerId: "p-gn" },
      ],
    });
    const plan = await planRetranslation(ledger, CI, rates, { from: "2025-01-01", date: "2025-12-31", reversalDate: "2026-01-01" });
    expect(plan.lines.map((l) => l.accountNumber)).toEqual(["401"]);
  });
});
