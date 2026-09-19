import { beforeEach, describe, expect, it } from "vitest";
import { importBalance, planBalanceImport } from "./balance-import.js";
import { EntryValidationError, LedgerError } from "./errors.js";
import { Ledger, soldeOf } from "./ledger.js";
import { MemoryStore } from "./memory-store.js";
import type { Actor, FiscalYear } from "./types.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const actor: Actor = { userId: "u1", tenantId: TENANT };
const other: Actor = { userId: "u2", tenantId: OTHER };

const CHART = [
  { number: "101", label: "Capital social" },
  { number: "121", label: "Report à nouveau créditeur" },
  { number: "244", label: "Matériel et mobilier" },
  { number: "284", label: "Amortissements du matériel" },
  { number: "401", label: "Fournisseurs", lettrable: true },
  { number: "411", label: "Clients", lettrable: true },
  { number: "443", label: "TVA facturée" },
  { number: "445", label: "TVA récupérable" },
  { number: "471", label: "Compte d'attente" },
  { number: "521", label: "Banques locales" },
  { number: "571", label: "Caisse" },
  { number: "622", label: "Locations" },
  { number: "706", label: "Services vendus" },
  { number: "41", label: "Clients et comptes rattachés", postable: false },
];

let store: MemoryStore;
let ledger: Ledger;
let fy: FiscalYear;

beforeEach(async () => {
  store = new MemoryStore();
  for (const t of [TENANT, OTHER]) {
    store.seedAccounts(t, CHART);
    store.seedJournals(t);
  }
  fy = await store.createFiscalYear(TENANT, { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  await store.createFiscalYear(OTHER, { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  ledger = new Ledger(store, { baseCurrency: "XOF" });
});

const sale = (over: Partial<Parameters<Ledger["createDraft"]>[1]> = {}) => ({
  journalCode: "VT",
  date: "2025-03-15",
  reference: "FAC-001",
  label: "Facture client",
  source: "INVOICE" as const,
  lines: [
    { accountNumber: "411", debit: "1180000", partnerId: "p-client" },
    { accountNumber: "706", credit: "1000000" },
    { accountNumber: "443", credit: "180000" },
  ],
  ...over,
});

describe("Ledger — invariants", () => {
  it("refuse une écriture déséquilibrée", async () => {
    await expect(
      ledger.createDraft(actor, sale({ lines: [{ accountNumber: "411", debit: "100", partnerId: "p" }, { accountNumber: "706", credit: "90" }] })),
    ).rejects.toMatchObject({ code: "UNBALANCED" });
  });

  it("refuse une ligne à la fois débitrice et créditrice, ou sans montant", async () => {
    await expect(
      ledger.createDraft(actor, sale({ lines: [{ accountNumber: "411", debit: "100", credit: "100", partnerId: "p" }, { accountNumber: "706", credit: "0" }] })),
    ).rejects.toBeInstanceOf(EntryValidationError);
  });

  it("refuse un compte inconnu, un compte de regroupement, un tiers manquant", async () => {
    await expect(ledger.createDraft(actor, sale({ lines: [{ accountNumber: "999", debit: "1" }, { accountNumber: "706", credit: "1" }] }))).rejects.toMatchObject({ code: "UNKNOWN_ACCOUNT" });
    await expect(ledger.createDraft(actor, sale({ lines: [{ accountNumber: "41", debit: "1" }, { accountNumber: "706", credit: "1" }] }))).rejects.toMatchObject({ code: "ACCOUNT_NOT_POSTABLE" });
    await expect(ledger.createDraft(actor, sale({ lines: [{ accountNumber: "411", debit: "1" }, { accountNumber: "706", credit: "1" }] }))).rejects.toMatchObject({ code: "PARTNER_REQUIRED" });
  });

  it("refuse une date hors exercice", async () => {
    await expect(ledger.createDraft(actor, sale({ date: "2024-12-31" }))).rejects.toMatchObject({ code: "NO_OPEN_PERIOD" });
  });

  it("valide : numérotation continue par journal et chaîne de hash", async () => {
    const e1 = await ledger.post(actor, sale());
    const e2 = await ledger.post(actor, sale({ reference: "FAC-002" }));
    const e3 = await ledger.post(actor, { ...sale(), journalCode: "OD", lines: [{ accountNumber: "521", debit: "10" }, { accountNumber: "571", credit: "10" }] });
    expect(e1.number).toBe(1);
    expect(e2.number).toBe(2);
    expect(e3.number).toBe(1);
    expect(e1.prevHash).toBeNull();
    expect(e2.prevHash).toBe(e1.hash);
    expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await ledger.verifyChain(TENANT, "VT")).toEqual({ ok: true, checked: 2 });
  });

  it("détecte une altération d'une écriture validée", async () => {
    const e1 = await ledger.post(actor, sale());
    await ledger.post(actor, sale({ reference: "FAC-002" }));
    store._unsafeTamper(e1.id, (e) => {
      e.label = "Facture modifiée";
    });
    const result = await ledger.verifyChain(TENANT, "VT");
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(e1.id);
  });

  it("une écriture validée est immuable : ni suppression ni double validation", async () => {
    const e = await ledger.post(actor, sale());
    await expect(ledger.discardDraft(actor, e.id)).rejects.toMatchObject({ code: "ENTRY_IMMUTABLE" });
    await expect(ledger.validate(actor, e.id)).rejects.toMatchObject({ code: "ENTRY_IMMUTABLE" });
  });

  it("contrepasse une écriture validée et interdit une seconde contrepassation", async () => {
    const e = await ledger.post(actor, sale());
    const r = await ledger.reverse(actor, e.id, { date: "2025-03-31" });
    expect(r.source).toBe("REVERSAL");
    expect(r.reversesEntryId).toBe(e.id);
    expect(r.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["411", "0.0000", "1180000.0000"],
      ["706", "1000000.0000", "0.0000"],
      ["443", "180000.0000", "0.0000"],
    ]);
    const again = await store.getEntry(TENANT, e.id);
    expect(again?.reversedByEntryId).toBe(r.id);
    await expect(ledger.reverse(actor, e.id)).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    expect(await ledger.verifyChain(TENANT, "VT")).toEqual({ ok: true, checked: 2 });
    const tb = await ledger.trialBalance(TENANT, { fiscalYearCode: "2025" });
    expect(soldeOf(tb.rows.find((r) => r.accountNumber === "411")!).amount.isZero()).toBe(true);
  });

  it("refuse toute écriture dans une période clôturée", async () => {
    const found = await store.findPeriodForDate(TENANT, "2025-03-15");
    await ledger.closePeriod(actor, found!.period, "CLOSED");
    await expect(ledger.createDraft(actor, sale())).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
    // Un brouillon créé avant la clôture ne peut plus être validé.
    const draft = await ledger.createDraft(actor, sale({ date: "2025-04-01" }));
    const april = await store.findPeriodForDate(TENANT, "2025-04-01");
    await ledger.closePeriod(actor, april!.period, "LOCKED");
    await expect(ledger.validate(actor, draft.id)).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
  });

  it("est idempotent sur clientId (synchronisation hors ligne)", async () => {
    const a = await ledger.createDraft(actor, sale({ clientId: "c-1" }));
    const b = await ledger.createDraft(actor, sale({ clientId: "c-1" }));
    expect(b.id).toBe(a.id);
  });

  it("ne fuit rien entre dossiers", async () => {
    const e = await ledger.post(actor, sale());
    expect(await store.getEntry(OTHER, e.id)).toBeNull();
    await expect(ledger.validate(other, e.id)).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
    const tb = await ledger.trialBalance(OTHER, { fiscalYearCode: "2025" });
    expect(tb.rows).toHaveLength(0);
  });

  it("produit une balance équilibrée avec soldes par compte", async () => {
    await ledger.post(actor, sale());
    await ledger.post(actor, { journalCode: "BQ", date: "2025-04-02", label: "Règlement", source: "BANK", lines: [{ accountNumber: "521", debit: "1180000" }, { accountNumber: "411", credit: "1180000", partnerId: "p-client" }] });
    const tb = await ledger.trialBalance(TENANT, { fiscalYearCode: fy.code });
    expect(tb.totalDebit.eq(tb.totalCredit)).toBe(true);
    expect(soldeOf(tb.rows.find((r) => r.accountNumber === "521")!)).toMatchObject({ side: "D" });
    expect(soldeOf(tb.rows.find((r) => r.accountNumber === "706")!)).toMatchObject({ side: "C" });
    expect(tb.rows.find((r) => r.accountNumber === "706")!.credit.toString()).toBe("1000000.0000");
  });

  it("journalise chaque action dans la piste d'audit", async () => {
    const e = await ledger.post(actor, sale());
    expect(store.audit.map((a) => a.action)).toEqual(["entry.draft", "entry.validate"]);
    expect(store.audit[1]?.entityId).toBe(e.id);
  });
});

describe("Import de balance", () => {
  const rows = [
    { account: "5121", label: "Banque", debit: "5000000", credit: "0" },
    { account: "57", label: "Caisse", debit: "500000", credit: "0" },
    { account: "2183", label: "Matériel", debit: "3000000", credit: "0" },
    { account: "2818", label: "Amortissements", debit: "0", credit: "1000000" },
    { account: "101", label: "Capital", debit: "0", credit: "5000000" },
    { account: "110", label: "RAN", debit: "0", credit: "2500000" },
    { account: "706", label: "Ventes", debit: "0", credit: "999" },
    { account: "622", label: "Loyers", debit: "999", credit: "0" },
  ];
  // Correspondance d'un plan de type PCG/Sage vers SYSCOHADA.
  const mapping = { "5121": "521", "57": "571", "2183": "244", "2818": "284", "110": "121" };

  it("construit une écriture d'à-nouveaux équilibrée en excluant les comptes de gestion", () => {
    const plan = planBalanceImport(rows, { mapping, date: "2025-01-01" });
    expect(plan.input.journalCode).toBe("AN");
    expect(plan.input.lines).toHaveLength(6);
    expect(plan.totalDebit.eq(plan.totalCredit)).toBe(true);
    expect(plan.skipped.map((s) => s.account)).toEqual(["706", "622"]);
  });

  it("refuse un compte sans correspondance ou un déséquilibre hors tolérance", () => {
    expect(() => planBalanceImport([...rows, { account: "BANQUE-2", debit: "1", credit: "0" }], { mapping, date: "2025-01-01" })).toThrow(LedgerError);
    const unbalanced = [...rows, { account: "471", debit: "5", credit: "0" }];
    expect(() => planBalanceImport(unbalanced, { mapping, date: "2025-01-01" })).toThrow(/déséquilibrée/);
    const plan = planBalanceImport(unbalanced, { mapping, date: "2025-01-01", tolerance: "10", roundingAccount: "471" });
    expect(plan.totalDebit.sub(plan.totalCredit).toString()).toBe("5.0000");
  });

  it("comptabilise les à-nouveaux dans le grand livre", async () => {
    const { entry } = await importBalance(ledger, actor, rows, { mapping, date: "2025-01-01" });
    expect(entry.status).toBe("VALIDATED");
    expect(entry.journalCode).toBe("AN");
    const tb = await ledger.trialBalance(TENANT, { fiscalYearCode: "2025" });
    expect(tb.totalDebit.toString()).toBe("8500000.0000");
  });
});
