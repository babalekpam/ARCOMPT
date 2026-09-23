// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Ledger, Money, PostgresStore } from "@arcompt/ledger";
import { loadPack } from "@arcompt/country-packs";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
// `@arcompt/db` n'expose pas « ./testing » dans son export map : import relatif.
import { createTestDatabase } from "../../../db/src/testing.js";
import type { TenantContext } from "../types.js";
import type { InvoicingDeps } from "../base.js";
import { StockService } from "./service.js";

/**
 * Stocks — inventaire intermittent. Base jetable migrée, rôle applicatif soumis
 * à la RLS, moteur comptable réel. Ignoré sans DATABASE_URL.
 *
 * Le premier bloc est un exemple chiffré complet, vérifiable à la main par un
 * comptable : stock initial, achats de l'exercice, comptage physique de
 * clôture, écritures de variation et effet sur le compte de résultat.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const pack = loadPack("ci");
let db: Db;
let appDb: Db;
let orgId: string;
let userId: string;
let tenantA: string;
let tenantB: string;
let supplier: string;
let customer: string;
let stockA: StockService;
let stockB: StockService;
let ledgerA: Ledger;

function serviceFor(tenantId: string): StockService {
  const store = new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId });
  const deps: InvoicingDeps = { db: appDb as unknown as Sql, ledger: new Ledger(store, { baseCurrency: "XOF" }), pack, currency: "XOF" };
  const ctx: TenantContext = { tenantId, userId, organizationId: orgId };
  return new StockService(deps, ctx);
}

/** Lignes d'une écriture : [compte, débit, crédit], dans l'ordre. */
async function entryLines(tenantId: string, entryId: string): Promise<Array<[string, string, string]>> {
  const rows = await withTenant(db, { tenantId }, (tx) =>
    tx`SELECT a.number, l.debit::text AS debit, l.credit::text AS credit FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ${entryId} ORDER BY l.line_no`,
  );
  return rows.map((r) => [r.number as string, r.debit as string, r.credit as string]);
}

/** Solde d'un compte au grand livre, dans la convention du compte de résultat : crédit − débit. */
async function creditMinusDebit(tenantId: string, number: string): Promise<Money> {
  const rows = await withTenant(db, { tenantId }, (tx) =>
    tx`SELECT coalesce(sum(l.credit_base - l.debit_base), 0)::text AS solde FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE l.tenant_id = ${tenantId} AND e.status = 'VALIDATED' AND a.number = ${number}`,
  );
  return Money.parse(rows[0]!.solde as string);
}

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test stocks') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'stock@t.t', 'Comptable') RETURNING id`;
  userId = u!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "Négoce A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "Négoce B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  const [s] = await withTenant(db, { tenantId: tenantA }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'SUPPLIER', 'Grossiste', '401') RETURNING id`,
  );
  supplier = s!.id as string;
  const [c] = await withTenant(db, { tenantId: tenantA }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Boutique', '411') RETURNING id`,
  );
  customer = c!.id as string;
  stockA = serviceFor(tenantA);
  stockB = serviceFor(tenantB);
  ledgerA = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
});

afterAll(async () => {
  await env?.drop();
});

/*
 * ---------------------------------------------------------------------------
 * EXEMPLE CHIFFRÉ — SARL de négoce, exercice 2025, devise XOF
 * ---------------------------------------------------------------------------
 * Marchandises (compte 311, variation 6031), évaluées au CUMP.
 *
 *   Stock initial au 01/01 (à-nouveaux)        100 sacs à 10 000 = 1 000 000
 *   Achat du 15/03                             300 sacs à 12 000 = 3 600 000
 *     → 400 sacs pour 4 600 000, CUMP 11 500
 *   Vente du 30/06                             250 sacs sortis   = 2 875 000
 *     → 150 sacs pour 1 725 000
 *   Achat du 10/09                             250 sacs à 13 000 = 3 250 000
 *     → 400 sacs pour 4 975 000, CUMP 12 437,50
 *   Vente du 15/12                             320 sacs sortis   = 3 980 000
 *     → stock théorique 80 sacs pour 995 000
 *   Comptage physique du 31/12                  78 sacs            = 970 125
 *     → écart d'inventaire : −2 sacs, soit −24 875
 *
 * Achats de l'exercice (601) : 3 600 000 + 3 250 000 = 6 850 000.
 * Ventes (701) : 11 400 000.
 *
 * Écritures de clôture (inventaire intermittent) :
 *   6031 D 1 000 000 à 311 C 1 000 000   (annulation du stock initial)
 *    311 D   970 125 à 6031 C   970 125  (constatation du stock final)
 *
 * Grand livre après clôture :
 *    311 = 970 125 débiteur   → bilan actif, poste BB « Stocks et encours »
 *   6031 =  29 875 débiteur   → compte de résultat, poste RB
 *
 * Compte de résultat (chaque poste vaut crédit − débit) :
 *   TA Ventes de marchandises          + 11 400 000
 *   RA Achats de marchandises          −  6 850 000
 *   RB Variation de stocks             −     29 875   (= SF − SI = 970 125 − 1 000 000)
 *   XA MARGE COMMERCIALE               +  4 520 125
 *
 * Coût d'achat des marchandises vendues = achats + SI − SF
 *                                       = 6 850 000 + 1 000 000 − 970 125 = 6 879 875,
 * qui est aussi la somme des sorties valorisées par le module :
 *   2 875 000 + 3 980 000 + 24 875 (écart d'inventaire) = 6 879 875.
 *
 * Produits finis (compte 361, variation 736), en parallèle :
 *   stock initial 200 000, production 300 000, sorties 400 000,
 *   stock final compté 100 000 → 736 débiteur de 100 000, poste TE = −100 000
 *   (« production stockée » négative : l'entreprise a déstocké).
 * ---------------------------------------------------------------------------
 */
run("Stocks — inventaire intermittent, exemple chiffré complet", () => {
  let marchandise: string;
  let produitFini: string;
  let countId: string;

  it("ouvre l'exercice : à-nouveaux, articles et stock initial", async () => {
    // À-nouveaux : le stock initial est au bilan, pas dans le module.
    await ledgerA.post(
      { userId, tenantId: tenantA },
      {
        journalCode: "AN",
        date: "2025-01-01",
        label: "Reprise des à-nouveaux",
        source: "IMPORT",
        lines: [
          { accountNumber: "311", debit: "1000000", label: "Stock initial marchandises" },
          { accountNumber: "361", debit: "200000", label: "Stock initial produits finis" },
          { accountNumber: "101", credit: "1200000", label: "Capital" },
        ],
      },
    );

    const march = await stockA.createArticle({ code: "MARCH-A", label: "Riz parfumé 25 kg", unit: "sac", category: "MARCHANDISE" });
    marchandise = march.id;
    expect([march.stockAccountNumber, march.variationAccountNumber, march.valuationMethod]).toEqual(["311", "6031", "CUMP"]);

    const pf = await stockA.createArticle({ code: "PF-1", label: "Sacs conditionnés", unit: "sac", category: "PRODUIT_FINI" });
    produitFini = pf.id;
    expect([pf.stockAccountNumber, pf.variationAccountNumber]).toEqual(["361", "736"]);

    await stockA.recordMovement({ articleId: marchandise, date: "2025-01-01", kind: "OPENING", quantity: "100", unitCost: "10000" });
    await stockA.recordMovement({ articleId: produitFini, date: "2025-01-01", kind: "OPENING", quantity: "20", unitCost: "10000" });
  });

  it("enregistre achats et ventes : la charge est en 601, le mouvement de stock n'est pas comptabilisé", async () => {
    for (const [date, quantity, unitCost, total] of [
      ["2025-03-15", "300", "12000", "3600000"],
      ["2025-09-10", "250", "13000", "3250000"],
    ] as const) {
      await ledgerA.post(
        { userId, tenantId: tenantA },
        {
          journalCode: "AC",
          date,
          label: "Achat de marchandises",
          source: "PURCHASE",
          lines: [
            { accountNumber: "601", debit: total, label: "Achats de marchandises" },
            { accountNumber: "401", credit: total, partnerId: supplier, label: "Grossiste" },
          ],
        },
      );
      const movement = await stockA.recordMovement({ articleId: marchandise, date, kind: "IN", reason: "PURCHASE", quantity, unitCost });
      // Le cœur de l'inventaire intermittent : le mouvement ne porte aucune écriture.
      expect(movement.entryId).toBeNull();
      expect(movement.value.toString()).toBe(`${total}.0000`);
    }

    await ledgerA.post(
      { userId, tenantId: tenantA },
      {
        journalCode: "VT",
        date: "2025-12-15",
        label: "Ventes de l'exercice",
        source: "INVOICE",
        lines: [
          { accountNumber: "411", debit: "11400000", partnerId: customer, label: "Boutique" },
          { accountNumber: "701", credit: "11400000", label: "Ventes de marchandises" },
        ],
      },
    );
    await stockA.recordMovement({ articleId: marchandise, date: "2025-06-30", kind: "OUT", reason: "SALE", quantity: "250" });
    await stockA.recordMovement({ articleId: marchandise, date: "2025-12-15", kind: "OUT", reason: "SALE", quantity: "320" });

    // Produits finis : production puis vente.
    await stockA.recordMovement({ articleId: produitFini, date: "2025-06-30", kind: "IN", reason: "PRODUCTION", quantity: "30", unitCost: "10000" });
    await stockA.recordMovement({ articleId: produitFini, date: "2025-11-30", kind: "OUT", reason: "SALE", quantity: "40" });
  });

  it("valorise le stock théorique au CUMP : 80 sacs pour 995 000, coût unitaire 12 437,50", async () => {
    const position = await stockA.position(marchandise, "2025-12-31");
    expect(position.quantity.toString()).toBe("80.0000");
    expect(position.value.toString()).toBe("995000.0000");
    expect(position.unitCost!.toString()).toBe("12437.5000");

    const movements = await stockA.listMovements({ articleId: marchandise });
    expect(movements.map((m) => [m.date, m.kind, m.quantity.toString(), m.value.toString(), m.quantityAfter.toString(), m.valueAfter.toString()])).toEqual([
      ["2025-01-01", "OPENING", "100.0000", "1000000.0000", "100.0000", "1000000.0000"],
      ["2025-03-15", "IN", "300.0000", "3600000.0000", "400.0000", "4600000.0000"],
      ["2025-06-30", "OUT", "250.0000", "2875000.0000", "150.0000", "1725000.0000"],
      ["2025-09-10", "IN", "250.0000", "3250000.0000", "400.0000", "4975000.0000"],
      ["2025-12-15", "OUT", "320.0000", "3980000.0000", "80.0000", "995000.0000"],
    ]);
  });

  it("valorise l'inventaire physique du 31/12 et mesure l'écart : 78 sacs comptés pour 970 125", async () => {
    const count = await stockA.createCount({
      fiscalYearCode: "2025",
      date: "2025-12-31",
      label: "Inventaire de clôture 2025",
      lines: [
        { articleId: marchandise, countedQuantity: "78", note: "2 sacs détériorés" },
        { articleId: produitFini, countedQuantity: "10" },
      ],
    });
    countId = count.id;
    const march = count.lines.find((l) => l.code === "MARCH-A")!;
    expect(march.theoreticalQuantity.toString()).toBe("80.0000");
    expect(march.theoreticalValue.toString()).toBe("995000.0000");
    expect(march.unitCost!.toString()).toBe("12437.5000");
    expect(march.value.toString()).toBe("970125.0000"); // 78 × 12 437,50
    expect(march.varianceQuantity.toString()).toBe("-2.0000");
    expect(march.varianceValue.toString()).toBe("-24875.0000");

    const pf = count.lines.find((l) => l.code === "PF-1")!;
    expect(pf.theoreticalQuantity.toString()).toBe("10.0000");
    expect(pf.value.toString()).toBe("100000.0000");
    expect(pf.varianceQuantity.isZero()).toBe(true);

    expect(count.totalValue.toString()).toBe("1070125.0000"); // 970 125 + 100 000
    expect(count.status).toBe("DRAFT");
  });

  it("valide l'inventaire avec régularisation : le stock théorique rejoint le comptage, sans écriture", async () => {
    const validated = await stockA.validateCount(countId, { adjust: true });
    expect(validated.status).toBe("VALIDATED");
    expect(validated.adjusted).toBe(true);

    const position = await stockA.position(marchandise, "2025-12-31");
    expect(position.quantity.toString()).toBe("78.0000");
    expect(position.value.toString()).toBe("970125.0000");

    const adjustments = (await stockA.listMovements({ articleId: marchandise })).filter((m) => m.reason === "COUNT_ADJUSTMENT");
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.kind).toBe("OUT");
    expect(adjustments[0]!.quantity.toString()).toBe("2.0000");
    expect(adjustments[0]!.value.toString()).toBe("24875.0000");
    expect(adjustments[0]!.entryId).toBeNull(); // toujours aucune écriture
  });

  it("passe la variation de stock de clôture : deux écritures par le moteur d'imputation", async () => {
    const closing = await stockA.closeFiscalYear("2025");
    expect(closing.closingDate).toBe("2025-12-31");
    expect(closing.lines).toEqual([
      expect.objectContaining({ stockAccountNumber: "311", variationAccountNumber: "6031" }),
      expect.objectContaining({ stockAccountNumber: "361", variationAccountNumber: "736" }),
    ]);
    const march = closing.lines.find((l) => l.stockAccountNumber === "311")!;
    expect(march.openingValue.toString()).toBe("1000000.0000");
    expect(march.closingValue.toString()).toBe("970125.0000");
    expect(march.variation.toString()).toBe("-29875.0000"); // déstockage

    // 1. Annulation des stocks initiaux : 603x / 73x D à 3xx C.
    expect(await entryLines(tenantA, closing.openingEntryId!)).toEqual([
      ["6031", "1000000.0000", "0.0000"],
      ["736", "200000.0000", "0.0000"],
      ["311", "0.0000", "1000000.0000"],
      ["361", "0.0000", "200000.0000"],
    ]);
    // 2. Constatation des stocks finals : 3xx D à 603x / 73x C.
    expect(await entryLines(tenantA, closing.closingEntryId!)).toEqual([
      ["311", "970125.0000", "0.0000"],
      ["361", "100000.0000", "0.0000"],
      ["6031", "0.0000", "970125.0000"],
      ["736", "0.0000", "100000.0000"],
    ]);
  });

  it("produit un bilan et un compte de résultat cohérents (postes BB, TA, RA, RB, XA, TE)", async () => {
    const balance = await ledgerA.trialBalance(tenantA, { fiscalYearCode: "2025" });
    const soldeDebiteur = (n: string) => {
      const row = balance.rows.find((r) => r.accountNumber === n)!;
      return row.debit.sub(row.credit);
    };

    // Bilan actif, poste BB « STOCKS ET ENCOURS » = +31 … +38 (valeur brute).
    expect(soldeDebiteur("311").toString()).toBe("970125.0000");
    expect(soldeDebiteur("361").toString()).toBe("100000.0000");
    const posteBB = soldeDebiteur("311").add(soldeDebiteur("361"));
    expect(posteBB.toString()).toBe("1070125.0000");
    // …et il vaut exactement l'inventaire physique valorisé.
    expect(posteBB.toString()).toBe((await stockA.getCount(countId)).totalValue.toString());

    // Compte de résultat : chaque poste vaut crédit − débit du compte.
    const posteTA = await creditMinusDebit(tenantA, "701"); // Ventes de marchandises
    const posteRA = await creditMinusDebit(tenantA, "601"); // Achats de marchandises
    const posteRB = await creditMinusDebit(tenantA, "6031"); // Variation de stocks de marchandises
    const posteTE = await creditMinusDebit(tenantA, "736"); // Production stockée (ou déstockage)
    expect(posteTA.toString()).toBe("11400000.0000");
    expect(posteRA.toString()).toBe("-6850000.0000");
    expect(posteRB.toString()).toBe("-29875.0000"); // SF − SI = 970 125 − 1 000 000
    expect(posteTE.toString()).toBe("-100000.0000"); // déstockage de produits finis

    // XA MARGE COMMERCIALE = TA + RA + RB.
    expect(posteTA.add(posteRA).add(posteRB).toString()).toBe("4520125.0000");

    // Coût d'achat des marchandises vendues = achats + SI − SF …
    const coutAchatVendu = posteRA.add(posteRB).neg();
    expect(coutAchatVendu.toString()).toBe("6879875.0000");
    // … et c'est exactement la somme des sorties valorisées par le module,
    // écart d'inventaire compris : 2 875 000 + 3 980 000 + 24 875.
    const sorties = (await stockA.listMovements({ articleId: marchandise }))
      .filter((m) => m.kind === "OUT")
      .reduce((a, m) => a.add(m.value), Money.zero());
    expect(sorties.toString()).toBe("6879875.0000");
  });

  it("ne clôture qu'une fois et gèle l'exercice clôturé", async () => {
    await expect(stockA.closeFiscalYear("2025")).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(stockA.recordMovement({ articleId: marchandise, date: "2025-12-20", kind: "OUT", quantity: "1" })).rejects.toMatchObject({ code: "PERIOD_CLOSED" });
    const closing = await stockA.getClosing("2025");
    expect(closing!.lines).toHaveLength(2);
    expect(await stockA.getClosing("2024")).toBeNull();
  });
});

run("Stocks — garde-fous et isolation", () => {
  let article: string;

  it("refuse une sortie supérieure au stock, y compris par saisie antidatée", async () => {
    const a = await stockB.createArticle({ code: "MP-1", label: "Farine", unit: "kg", category: "MATIERE_PREMIERE", valuationMethod: "FIFO" });
    article = a.id;
    expect([a.stockAccountNumber, a.variationAccountNumber]).toEqual(["321", "6032"]);
    await stockB.recordMovement({ articleId: article, date: "2025-02-01", kind: "IN", quantity: "100", unitCost: "500" });
    await expect(stockB.recordMovement({ articleId: article, date: "2025-03-01", kind: "OUT", quantity: "101" })).rejects.toMatchObject({ code: "VALIDATION" });
    await stockB.recordMovement({ articleId: article, date: "2025-03-01", kind: "OUT", quantity: "60" });
    // Une sortie antidatée au 15/01, avant la seule entrée, rendrait le stock
    // négatif : le rejeu la refuse et rien n'est enregistré.
    await expect(stockB.recordMovement({ articleId: article, date: "2025-01-15", kind: "OUT", quantity: "10" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await stockB.listMovements({ articleId: article })).toHaveLength(2);
  });

  it("refuse un compte non imputable, un compte hors classe 3 et un doublon de code", async () => {
    await expect(stockB.createArticle({ code: "X1", label: "X", category: "MARCHANDISE", stockAccountNumber: "31" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(stockB.createArticle({ code: "X2", label: "X", category: "MARCHANDISE", stockAccountNumber: "601" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(stockB.createArticle({ code: "X3", label: "X", category: "MARCHANDISE", variationAccountNumber: "603" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(stockB.createArticle({ code: "MP-1", label: "Doublon", category: "MATIERE_PREMIERE" })).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("refuse de changer la méthode d'évaluation d'un article déjà mouvementé", async () => {
    await expect(stockB.updateArticle(article, { valuationMethod: "CUMP" })).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect((await stockB.updateArticle(article, { label: "Farine de blé" })).label).toBe("Farine de blé");
  });

  it("refuse de clôturer sans inventaire validé", async () => {
    await expect(stockB.closeFiscalYear("2025")).rejects.toMatchObject({ code: "VALIDATION" });
    const draft = await stockB.createCount({ fiscalYearCode: "2025", date: "2025-12-31", lines: [{ articleId: article, countedQuantity: "40" }] });
    await expect(stockB.closeFiscalYear("2025", { countId: draft.id })).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await stockB.validateCount(draft.id);
  });

  it("annule aussi le stock initial d'un compte de classe 3 qu'aucun article ne porte", async () => {
    // Le dossier B a repris un stock d'emballages (331) en à-nouveaux sans
    // déclarer d'article : son solde doit quand même être soldé à la clôture,
    // sans quoi le bilan garderait un stock fantôme.
    const ledgerB = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
    await ledgerB.post(
      { userId, tenantId: tenantB },
      {
        journalCode: "AN",
        date: "2025-01-01",
        label: "Reprise des à-nouveaux",
        source: "IMPORT",
        lines: [
          { accountNumber: "321", debit: "50000", label: "Stock initial matières" },
          { accountNumber: "331", debit: "30000", label: "Stock initial emballages" },
          { accountNumber: "101", credit: "80000", label: "Capital" },
        ],
      },
    );
    const closing = await stockB.closeFiscalYear("2025");
    const emballages = closing.lines.find((l) => l.stockAccountNumber === "331")!;
    expect(emballages.variationAccountNumber).toBe("6033");
    expect(emballages.openingValue.toString()).toBe("30000.0000");
    expect(emballages.closingValue.toString()).toBe("0.0000");
    // 40 kg comptés sur les couches PEPS à 500 → 20 000.
    const matieres = closing.lines.find((l) => l.stockAccountNumber === "321")!;
    expect(matieres.openingValue.toString()).toBe("50000.0000");
    expect(matieres.closingValue.toString()).toBe("20000.0000");
    expect(await entryLines(tenantB, closing.openingEntryId!)).toEqual([
      ["6032", "50000.0000", "0.0000"],
      ["6033", "30000.0000", "0.0000"],
      ["321", "0.0000", "50000.0000"],
      ["331", "0.0000", "30000.0000"],
    ]);
    expect(await entryLines(tenantB, closing.closingEntryId!)).toEqual([
      ["321", "20000.0000", "0.0000"],
      ["6032", "0.0000", "20000.0000"],
    ]);
  });

  it("isole les dossiers (RLS) : le dossier B ne voit rien du dossier A", async () => {
    expect((await stockB.listArticles()).map((a) => a.code)).toEqual(["MP-1"]);
    await expect(stockB.getArticle((await stockA.listArticles())[0]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stockB.listCounts({ fiscalYearCode: "2025" })).toHaveLength(1);
    // Lecture brute avec le rôle applicatif : aucune ligne du dossier A.
    const rows = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM stock_movement WHERE article_id <> ${article}`);
    expect(rows[0]!.n).toBe(0);
  });
});
