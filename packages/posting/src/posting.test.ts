import { describe, expect, it } from "vitest";
import { Money, type JournalEntryInput } from "@arcompt/ledger";
import { loadPack } from "@arcompt/country-packs";
import { buildEntry, DEFAULT_TEMPLATES, PostingError, computeDocumentTotals, resolveAccount, type PostingContext, type PostingEvent } from "./index.js";

const pack = loadPack("ci");
const ctx: PostingContext = { pack, currency: "XOF" };
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SUPPLIER = "22222222-2222-4222-8222-222222222222";
const EMPLOYEE = "33333333-3333-4333-8333-333333333333";

function totals(entry: JournalEntryInput) {
  const d = entry.lines.reduce((acc, l) => acc.add(l.debit ? Money.parse(l.debit) : Money.zero()), Money.zero());
  const c = entry.lines.reduce((acc, l) => acc.add(l.credit ? Money.parse(l.credit) : Money.zero()), Money.zero());
  return { debit: d, credit: c };
}

function expectBalanced(entry: JournalEntryInput) {
  const { debit, credit } = totals(entry);
  expect(debit.toString()).toBe(credit.toString());
  expect(entry.lines.length).toBeGreaterThanOrEqual(2);
  for (const l of entry.lines) {
    const amount = Money.parse(l.debit ?? l.credit ?? "0");
    expect(amount.isPositive()).toBe(true);
    expect(l.debit !== undefined && l.credit !== undefined).toBe(false);
  }
}

const line = (entry: JournalEntryInput, account: string) => entry.lines.find((l) => l.accountNumber === account);

describe("calcul des totaux et de la TVA", () => {
  it("arrondit la TVA ligne à ligne en XOF (0 décimale) et garde TTC = HT + TVA", () => {
    // 3 lignes de 33 333 à 18 % : 5 999,94 → 6 000 chacune ; total 18 000 (vs 17 999,82 → 18 000 sur le total).
    const lines = [1, 2, 3].map(() => ({ amount: "33333", vatCode: "TVA18" }));
    const perLine = computeDocumentTotals(lines, { pack, date: "2025-03-01", currency: "XOF" });
    expect(perLine.lines.map((l) => l.vat.toString())).toEqual(["6000.0000", "6000.0000", "6000.0000"]);
    expect(perLine.totalNet.toString()).toBe("99999.0000");
    expect(perLine.totalVat.toString()).toBe("18000.0000");
    expect(perLine.totalGross.toString()).toBe("117999.0000");
    expect(perLine.byVatCode[0]?.collectedAccount).toBe("443");
  });

  it("l'arrondi par ligne et l'arrondi sur le total peuvent différer, mais chacun reste cohérent", () => {
    // 7 lignes de 1 001 à 18 % : 180,18 → 180 par ligne (1 260) ; total 7 007 × 18 % = 1 261,26 → 1 261.
    const lines = Array.from({ length: 7 }, () => ({ amount: "1001", vatCode: "TVA18" }));
    const perLine = computeDocumentTotals(lines, { pack, date: "2025-03-01", currency: "XOF", vatRounding: "per_line" });
    const total = computeDocumentTotals(lines, { pack, date: "2025-03-01", currency: "XOF", vatRounding: "total" });
    expect(perLine.totalVat.toString()).toBe("1260.0000");
    expect(total.totalVat.toString()).toBe("1261.0000");
    // En mode total, la somme des TVA de lignes vaut exactement la TVA du récapitulatif.
    const allocated = total.lines.reduce((a, l) => a.add(l.vat), Money.zero());
    expect(allocated.toString()).toBe("1261.0000");
    expect(total.totalGross.toString()).toBe(total.totalNet.add(total.totalVat).toString());
  });

  it("gère les devises à deux décimales et les lignes exonérées", () => {
    const t = computeDocumentTotals(
      [
        { amount: "10.005", vatCode: "TVA18" },
        { amount: "20", vatCode: "EXO" },
        { amount: "5" },
      ],
      { pack, date: "2025-03-01", currency: "EUR" },
    );
    expect(t.lines[0]?.net.toString()).toBe("10.0100"); // 10,005 arrondi à 10,01
    expect(t.lines[0]?.vat.toString()).toBe("1.8000");
    expect(t.lines[1]?.vat.toString()).toBe("0.0000");
    expect(t.totalGross.toString()).toBe("36.8100");
    expect(t.byVatCode.map((r) => r.vatCode)).toEqual(["TVA18", "EXO"]);
  });

  it("refuse un code TVA inconnu du pack", () => {
    expect(() => computeDocumentTotals([{ amount: "100", vatCode: "TVA99" }], { pack, date: "2025-03-01", currency: "XOF" })).toThrow(/TVA99/);
  });
});

describe("résolution des comptes par rôle", () => {
  const event: PostingEvent = { kind: "SALES_INVOICE", date: "2025-03-01", label: "x", currency: "XOF" };
  it("suit l'ordre ligne → tiers → pack → surcharge → défaut", () => {
    expect(resolveAccount("customer", ctx, event)).toBe("411");
    expect(resolveAccount("customer", ctx, { ...event, partnerAccountNumber: "4111" })).toBe("4111");
    expect(resolveAccount("revenue", ctx, event)).toBe("706");
    expect(resolveAccount("withholding_tax", { ...ctx, accounts: { withholding_tax: "4471" } }, event)).toBe("4471");
    expect(resolveAccount("vat_collected", ctx, event)).toBe("443");
    expect(resolveAccount("treasury", ctx, { ...event, treasuryAccountNumber: "5381" })).toBe("5381");
    expect(() => resolveAccount("treasury", ctx, event)).toThrow(PostingError);
    expect(() => resolveAccount("depreciation", ctx, event)).toThrow(/depreciation/);
  });
});

describe("modèles par défaut", () => {
  const saleLines = [
    { label: "Prestation", amount: "1000000", accountNumber: "706", vatCode: "TVA18" },
    { label: "Marchandises", amount: "250000", accountNumber: "701", vatCode: "TVA18" },
    { label: "Formation exonérée", amount: "100000", accountNumber: "706", vatCode: "EXO" },
  ];

  it("SALES_INVOICE : 411 TTC à 70x par compte et 443 par code TVA", () => {
    const entry = buildEntry(
      { kind: "SALES_INVOICE", date: "2025-03-15", reference: "FAC-2025-0001", label: "Facture Client Alpha", currency: "XOF", partnerId: CUSTOMER, lines: saleLines },
      DEFAULT_TEMPLATES.SALES_INVOICE,
      ctx,
    );
    expectBalanced(entry);
    expect(entry.journalCode).toBe("VT");
    expect(entry.source).toBe("INVOICE");
    expect(entry.reference).toBe("FAC-2025-0001");
    expect(line(entry, "411")?.debit?.toString()).toBe("1575000.0000");
    expect(line(entry, "411")?.partnerId).toBe(CUSTOMER);
    expect(line(entry, "706")?.credit?.toString()).toBe("1100000.0000"); // 1 000 000 + 100 000 regroupés
    expect(line(entry, "701")?.credit?.toString()).toBe("250000.0000");
    const vat = entry.lines.filter((l) => l.accountNumber === "443");
    expect(vat).toHaveLength(1); // EXO à zéro est omis
    expect(vat[0]?.credit?.toString()).toBe("225000.0000");
    expect(vat[0]?.vatCode).toBe("TVA18");
  });

  it("SALES_CREDIT_NOTE : sens inverse de la facture", () => {
    const entry = buildEntry({ kind: "SALES_CREDIT_NOTE", date: "2025-03-20", label: "Avoir", currency: "XOF", partnerId: CUSTOMER, lines: saleLines }, DEFAULT_TEMPLATES.SALES_CREDIT_NOTE, ctx);
    expectBalanced(entry);
    expect(line(entry, "411")?.credit?.toString()).toBe("1575000.0000");
    expect(line(entry, "706")?.debit?.toString()).toBe("1100000.0000");
    expect(line(entry, "443")?.debit?.toString()).toBe("225000.0000");
  });

  it("CUSTOMER_PAYMENT : journal selon la trésorerie (521 → BQ, 571 → CA, 5381 → BQ)", () => {
    for (const [account, journal] of [
      ["521", "BQ"],
      ["571", "CA"],
      ["5381", "BQ"],
    ] as const) {
      const entry = buildEntry(
        { kind: "CUSTOMER_PAYMENT", date: "2025-04-02", label: "Règlement", currency: "XOF", partnerId: CUSTOMER, treasuryAccountNumber: account, amounts: { amount: "1575000" } },
        DEFAULT_TEMPLATES.CUSTOMER_PAYMENT,
        ctx,
      );
      expectBalanced(entry);
      expect(entry.journalCode).toBe(journal);
      expect(line(entry, account)?.debit?.toString()).toBe("1575000.0000");
      expect(line(entry, "411")?.credit?.toString()).toBe("1575000.0000");
      expect(line(entry, "411")?.partnerId).toBe(CUSTOMER);
    }
  });

  it("CUSTOMER_PAYMENT : montant manquant → PostingError", () => {
    expect(() =>
      buildEntry({ kind: "CUSTOMER_PAYMENT", date: "2025-04-02", label: "x", currency: "XOF", partnerId: CUSTOMER, treasuryAccountNumber: "521" }, DEFAULT_TEMPLATES.CUSTOMER_PAYMENT, ctx),
    ).toThrow(/amount/);
  });

  const purchaseLines = [
    { label: "Loyer mars", amount: "400000", accountNumber: "622", vatCode: "TVA18" },
    { label: "Fournitures", amount: "33333", accountNumber: "6055", vatCode: "TVA18" },
    { label: "Assurance", amount: "50000", accountNumber: "625", vatCode: "EXO" },
  ];

  it("PURCHASE_INVOICE : 6xx par ligne et 445 par code à 401 TTC", () => {
    const entry = buildEntry({ kind: "PURCHASE_INVOICE", date: "2025-03-20", reference: "FF-0042", label: "Facture Bêta", currency: "XOF", partnerId: SUPPLIER, lines: purchaseLines }, DEFAULT_TEMPLATES.PURCHASE_INVOICE, ctx);
    expectBalanced(entry);
    expect(entry.journalCode).toBe("AC");
    expect(line(entry, "622")?.debit?.toString()).toBe("400000.0000");
    expect(line(entry, "622")?.label).toBe("Loyer mars");
    expect(line(entry, "6055")?.debit?.toString()).toBe("33333.0000");
    expect(line(entry, "445")?.debit?.toString()).toBe("78000.0000"); // 72 000 + 6 000 (5 999,94 arrondi)
    expect(line(entry, "401")?.credit?.toString()).toBe("561333.0000");
    expect(line(entry, "401")?.partnerId).toBe(SUPPLIER);
  });

  it("PURCHASE_CREDIT_NOTE : sens inverse", () => {
    const entry = buildEntry({ kind: "PURCHASE_CREDIT_NOTE", date: "2025-03-25", label: "Avoir Bêta", currency: "XOF", partnerId: SUPPLIER, lines: purchaseLines }, DEFAULT_TEMPLATES.PURCHASE_CREDIT_NOTE, ctx);
    expectBalanced(entry);
    expect(line(entry, "401")?.debit?.toString()).toBe("561333.0000");
    expect(line(entry, "445")?.credit?.toString()).toBe("78000.0000");
  });

  it("SUPPLIER_PAYMENT : 401 à trésorerie", () => {
    const entry = buildEntry(
      { kind: "SUPPLIER_PAYMENT", date: "2025-04-05", label: "Virement Bêta", currency: "XOF", partnerId: SUPPLIER, treasuryAccountNumber: "521", amounts: { amount: "561333" } },
      DEFAULT_TEMPLATES.SUPPLIER_PAYMENT,
      ctx,
    );
    expectBalanced(entry);
    expect(line(entry, "401")?.debit?.toString()).toBe("561333.0000");
    expect(line(entry, "521")?.credit?.toString()).toBe("561333.0000");
  });

  it("EXPENSE_CLAIM : charges à 421 salarié", () => {
    const entry = buildEntry(
      { kind: "EXPENSE_CLAIM", date: "2025-03-28", label: "Note de frais Kouassi", currency: "XOF", partnerId: EMPLOYEE, lines: [{ label: "Taxi", amount: "15000", accountNumber: "614" }, { label: "Repas", amount: "20000", accountNumber: "638", vatCode: "TVA18" }] },
      DEFAULT_TEMPLATES.EXPENSE_CLAIM,
      ctx,
    );
    expectBalanced(entry);
    expect(line(entry, "614")?.debit?.toString()).toBe("15000.0000");
    expect(line(entry, "445")?.debit?.toString()).toBe("3600.0000");
    expect(line(entry, "421")?.credit?.toString()).toBe("38600.0000");
    expect(line(entry, "421")?.partnerId).toBe(EMPLOYEE);
  });

  it("PAYROLL_RUN : 661 + 664 à 422 (par salarié), 431 et 447 (4471 via surcharge)", () => {
    // Brut 1 000 000 ; CNPS salariale 63 000, patronale 77 000 ; ITS 120 000 ; net 817 000.
    const entry = buildEntry(
      {
        kind: "PAYROLL_RUN",
        date: "2025-03-31",
        label: "Paie mars 2025",
        currency: "XOF",
        amounts: { gross: "1000000", employer_contributions: "77000", social_contributions: "140000", income_tax: "120000" },
        lines: [
          { label: "Kouassi", amount: "500000", partnerId: EMPLOYEE },
          { label: "Diallo", amount: "317000", partnerId: "44444444-4444-4444-8444-444444444444" },
        ],
      },
      DEFAULT_TEMPLATES.PAYROLL_RUN,
      { ...ctx, accounts: { withholding_tax: "4471", social_body: "4311" } },
    );
    expectBalanced(entry);
    expect(entry.journalCode).toBe("PA");
    expect(line(entry, "661")?.debit?.toString()).toBe("1000000.0000");
    expect(line(entry, "664")?.debit?.toString()).toBe("77000.0000");
    expect(line(entry, "4311")?.credit?.toString()).toBe("140000.0000");
    expect(line(entry, "4471")?.credit?.toString()).toBe("120000.0000");
    const nets = entry.lines.filter((l) => l.accountNumber === "422");
    expect(nets).toHaveLength(2);
    expect(nets[0]?.partnerId).toBe(EMPLOYEE);
    expect(nets[0]?.label).toBe("Net à payer Kouassi");
  });

  it("PAYROLL_RUN incohérent → UNBALANCED", () => {
    expect(() =>
      buildEntry(
        { kind: "PAYROLL_RUN", date: "2025-03-31", label: "Paie", currency: "XOF", amounts: { gross: "1000000", employer_contributions: "0", social_contributions: "0", income_tax: "0" }, lines: [{ amount: "900000", partnerId: EMPLOYEE }] },
        DEFAULT_TEMPLATES.PAYROLL_RUN,
        ctx,
      ),
    ).toThrow(PostingError);
  });

  it("VAT_SETTLEMENT : 443 à 445, solde en 444 (dette)", () => {
    const entry = buildEntry({ kind: "VAT_SETTLEMENT", date: "2025-03-31", label: "TVA mars 2025", currency: "XOF", amounts: { vat_collected: "225000", vat_deductible: "78000" } }, DEFAULT_TEMPLATES.VAT_SETTLEMENT, ctx);
    expectBalanced(entry);
    expect(entry.journalCode).toBe("OD");
    expect(entry.source).toBe("TAX");
    expect(line(entry, "443")?.debit?.toString()).toBe("225000.0000");
    expect(line(entry, "445")?.credit?.toString()).toBe("78000.0000");
    expect(line(entry, "444")?.credit?.toString()).toBe("147000.0000");
  });

  it("VAT_SETTLEMENT : crédit de TVA → 444 au débit", () => {
    const entry = buildEntry({ kind: "VAT_SETTLEMENT", date: "2025-03-31", label: "TVA", currency: "XOF", amounts: { vat_collected: "50000", vat_deductible: "80000" } }, DEFAULT_TEMPLATES.VAT_SETTLEMENT, ctx);
    expectBalanced(entry);
    expect(line(entry, "444")?.debit?.toString()).toBe("30000.0000");
  });

  it("DEPRECIATION : 681 à 28xx par ligne", () => {
    const entry = buildEntry(
      { kind: "DEPRECIATION", date: "2025-12-31", label: "Dotations 2025", currency: "XOF", lines: [{ label: "Véhicule", amount: "600000", accountNumber: "2845" }, { label: "Mobilier", amount: "150000", accountNumber: "2844" }] },
      DEFAULT_TEMPLATES.DEPRECIATION,
      ctx,
    );
    expectBalanced(entry);
    expect(entry.journalCode).toBe("OD");
    expect(entry.lines.filter((l) => l.accountNumber === "681")).toHaveLength(2);
    expect(line(entry, "2845")?.credit?.toString()).toBe("600000.0000");
    expect(line(entry, "2844")?.credit?.toString()).toBe("150000.0000");
    expect(line(entry, "2845")?.label).toBe("Amortissement Véhicule");
  });

  it("chaque modèle par défaut produit une écriture équilibrée sur un jeu d'essai", () => {
    const events: PostingEvent[] = [
      { kind: "SALES_INVOICE", date: "2025-03-15", label: "v", currency: "XOF", partnerId: CUSTOMER, lines: saleLines },
      { kind: "SALES_CREDIT_NOTE", date: "2025-03-15", label: "a", currency: "XOF", partnerId: CUSTOMER, lines: saleLines },
      { kind: "CUSTOMER_PAYMENT", date: "2025-03-15", label: "r", currency: "XOF", partnerId: CUSTOMER, treasuryAccountNumber: "571", amounts: { amount: "10" } },
      { kind: "PURCHASE_INVOICE", date: "2025-03-15", label: "f", currency: "XOF", partnerId: SUPPLIER, lines: purchaseLines },
      { kind: "PURCHASE_CREDIT_NOTE", date: "2025-03-15", label: "af", currency: "XOF", partnerId: SUPPLIER, lines: purchaseLines },
      { kind: "SUPPLIER_PAYMENT", date: "2025-03-15", label: "p", currency: "XOF", partnerId: SUPPLIER, treasuryAccountNumber: "5381", amounts: { amount: "10" } },
      { kind: "EXPENSE_CLAIM", date: "2025-03-15", label: "n", currency: "XOF", partnerId: EMPLOYEE, lines: purchaseLines },
      { kind: "PAYROLL_RUN", date: "2025-03-15", label: "p", currency: "XOF", amounts: { gross: "100", employer_contributions: "10", social_contributions: "16", income_tax: "4" }, lines: [{ amount: "90", partnerId: EMPLOYEE }] },
      { kind: "VAT_SETTLEMENT", date: "2025-03-15", label: "t", currency: "XOF", amounts: { vat_collected: "10", vat_deductible: "3" } },
      { kind: "DEPRECIATION", date: "2025-03-15", label: "d", currency: "XOF", lines: [{ amount: "5", accountNumber: "2844" }] },
    ];
    for (const e of events) expectBalanced(buildEntry(e, DEFAULT_TEMPLATES[e.kind], ctx));
    expect(Object.keys(DEFAULT_TEMPLATES)).toHaveLength(10);
  });

  it("refuse un modèle appliqué au mauvais événement", () => {
    expect(() => buildEntry({ kind: "SALES_INVOICE", date: "2025-03-15", label: "v", currency: "XOF", lines: saleLines }, DEFAULT_TEMPLATES.PURCHASE_INVOICE, ctx)).toThrow(/Modèle/);
  });

  it("l'arrondi de TVA sur le total reste équilibré", () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({ label: `L${i}`, amount: "1001", accountNumber: "706", vatCode: "TVA18" }));
    const entry = buildEntry({ kind: "SALES_INVOICE", date: "2025-03-15", label: "v", currency: "XOF", partnerId: CUSTOMER, lines }, DEFAULT_TEMPLATES.SALES_INVOICE, { ...ctx, vatRounding: "total" });
    expectBalanced(entry);
    expect(line(entry, "443")?.credit?.toString()).toBe("1261.0000");
    expect(line(entry, "411")?.debit?.toString()).toBe("8268.0000");
  });
});
