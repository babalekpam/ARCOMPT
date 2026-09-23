import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Ledger, Money, PostgresStore } from "@arcompt/ledger";
import { loadPack } from "@arcompt/country-packs";
import { createTestDatabase } from "../../db/src/testing.js";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import {
  InvoicingError,
  InvoicingService,
  MemoryDunningSender,
  MockFneConnector,
  MockPaymentProvider,
  NullConnector,
  PaymentsService,
  PurchasesService,
  agingBucket,
  type InvoicingDeps,
  type TenantContext,
} from "./index.js";

/**
 * Tests d'intégration du module facturation : base jetable migrée, rôle
 * applicatif soumis à la RLS, moteur comptable réel. Ignorés sans DATABASE_URL.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const pack = loadPack("ci");
/** Horloge fixe dans l'exercice 2025 : dates de règlement des webhooks et fraîcheur des horodatages. */
const NOW = new Date("2025-06-01T12:00:00Z");
let db: Db;
let appDb: Db;
let orgId: string;
let userA: string; // comptable : saisit
let userB: string; // dirigeant : approuve
let tenantA: string;
let tenantB: string;
let customer: string;
let supplier: string;
let employee: string;
let fne: MockFneConnector;
let mobile: MockPaymentProvider;

function depsFor(overrides: Partial<InvoicingDeps> = {}): InvoicingDeps {
  const store = new PostgresStore(appDb as unknown as Sql, { userId: userA, organizationId: orgId });
  return { db: appDb as unknown as Sql, ledger: new Ledger(store, { baseCurrency: "XOF" }), pack, currency: "XOF", certification: fne, paymentProviders: { mock: mobile }, now: () => NOW, ...overrides };
}

function services(ctx: TenantContext, overrides: Partial<InvoicingDeps> = {}) {
  const deps = depsFor(overrides);
  return { invoicing: new InvoicingService(deps, ctx), purchases: new PurchasesService(deps, ctx), payments: new PaymentsService(deps, ctx) };
}

let ctxA: TenantContext;
let ctxB: TenantContext; // même dossier, autre utilisateur
let ctxOther: TenantContext; // autre dossier

async function entryOf(entryId: string) {
  return withTenant(db, { tenantId: tenantA }, async (tx) => {
    const [e] = await tx`SELECT e.*, j.code AS journal_code FROM journal_entry e JOIN journal j ON j.id = e.journal_id WHERE e.id = ${entryId}`;
    const lines = await tx`SELECT a.number AS account, l.debit::text AS debit, l.credit::text AS credit, l.partner_id, l.vat_code FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ${entryId} ORDER BY l.line_no`;
    return { entry: e!, lines };
  });
}

function expectBalanced(lines: { debit: string; credit: string }[]) {
  const d = lines.reduce((a, l) => a.add(Money.parse(l.debit)), Money.zero());
  const c = lines.reduce((a, l) => a.add(Money.parse(l.credit)), Money.zero());
  expect(d.toString()).toBe(c.toString());
  expect(d.isPositive()).toBe(true);
}

const invoiceInput = (issueDate = "2025-03-15", dueDate = "2025-04-14") => ({
  kind: "INVOICE" as const,
  partnerId: customer,
  issueDate,
  dueDate,
  lines: [
    { label: "Prestation de conseil", quantity: "1", unitPrice: "1000000", accountNumber: "706", vatCode: "TVA18" },
    { label: "Marchandises", quantity: "3", unitPrice: "33333", accountNumber: "701", vatCode: "TVA18" },
    { label: "Formation exonérée", quantity: "1", unitPrice: "100000", accountNumber: "706", vatCode: "EXO" },
  ],
});

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test facturation') RETURNING id`;
  orgId = org!.id as string;
  const [ua] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'a@t.t', 'Comptable') RETURNING id`;
  const [ub] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'b@t.t', 'Dirigeant') RETURNING id`;
  userA = ua!.id as string;
  userB = ub!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  await withTenant(db, { tenantId: tenantA }, async (tx) => {
    const [c] = await tx`INSERT INTO partner (tenant_id, type, name, collective_account, contact) VALUES (${tenantA}, 'CUSTOMER', 'Client Alpha', '411', '{"phone": "+2250700000000"}') RETURNING id`;
    const [s] = await tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'SUPPLIER', 'Fournisseur Bêta', '401') RETURNING id`;
    const [e] = await tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'EMPLOYEE', 'Kouassi', '421') RETURNING id`;
    customer = c!.id as string;
    supplier = s!.id as string;
    employee = e!.id as string;
    // Seuil de double validation relevé pour les tests courants ; le test d'approbation le dépasse.
    await tx`INSERT INTO invoicing_settings (tenant_id, payment_approval_threshold) VALUES (${tenantA}, 5000000)`;
    // Janvier 2025 clôturé : sert au test d'antidatage.
    await tx`UPDATE period SET status = 'CLOSED' WHERE tenant_id = ${tenantA} AND start_date = '2025-01-01'`;
  });
  fne = new MockFneConnector();
  mobile = new MockPaymentProvider({ secret: "s3cret" }, () => NOW);
  ctxA = { tenantId: tenantA, userId: userA, organizationId: orgId };
  ctxB = { tenantId: tenantA, userId: userB, organizationId: orgId };
  ctxOther = { tenantId: tenantB, userId: userA, organizationId: orgId };
});

afterAll(async () => {
  await env?.drop();
});

run("catalogue", () => {
  it("crée, lit et met à jour un produit", async () => {
    const { invoicing } = services(ctxA);
    const p = await invoicing.createProduct({ code: "CONSEIL", label: "Conseil (jour)", defaultAccountNumber: "706", vatCode: "TVA18", unitPrice: "250000" });
    expect(p.unitPrice.toString()).toBe("250000.0000");
    const updated = await invoicing.updateProduct(p.id, { unitPrice: "300000", active: false });
    expect(updated.unitPrice.toString()).toBe("300000.0000");
    expect((await invoicing.listProducts()).find((x) => x.id === p.id)).toBeUndefined();
    expect((await invoicing.listProducts({ includeInactive: true })).find((x) => x.id === p.id)).toBeDefined();
    await expect(invoicing.createProduct({ code: "CONSEIL", label: "x", defaultAccountNumber: "706" })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(invoicing.createProduct({ code: "X", label: "x", defaultAccountNumber: "706", vatCode: "TVA99" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

run("factures de vente", () => {
  it("calcule les totaux avec Money (HT × quantité, TVA par ligne arrondie en XOF)", async () => {
    const { invoicing } = services(ctxA);
    const draft = await invoicing.createDraft(invoiceInput());
    expect(draft.status).toBe("DRAFT");
    expect(draft.number).toBeNull();
    expect(draft.lines[1]?.net.toString()).toBe("99999.0000");
    expect(draft.lines[1]?.vat.toString()).toBe("18000.0000"); // 17 999,82 → 18 000
    expect(draft.totalNet.toString()).toBe("1199999.0000");
    expect(draft.totalVat.toString()).toBe("198000.0000");
    expect(draft.totalGross.toString()).toBe("1397999.0000");
    await invoicing.cancel(draft.id);
  });

  it("émet une facture : numéro légal, certification FNE, écriture équilibrée 411 / 70x / 443", async () => {
    const { invoicing } = services(ctxA);
    const draft = await invoicing.createDraft(invoiceInput());
    const issued = await invoicing.issue(draft.id);
    expect(issued.status).toBe("SENT");
    expect(issued.number).toMatch(/^FAC-2025-\d{4}$/);
    expect(issued.certification?.reference).toMatch(/^FNE-/);
    expect(issued.certification?.system).toContain("FNE");
    expect(issued.entryId).toBeTruthy();
    const { entry, lines } = await entryOf(issued.entryId!);
    expect(entry.status).toBe("VALIDATED");
    expect(entry.journal_code).toBe("VT");
    expect(entry.reference).toBe(issued.number);
    expectBalanced(lines as never);
    expect(lines.find((l) => l.account === "411")?.debit).toBe("1397999.0000");
    expect(lines.find((l) => l.account === "411")?.partner_id).toBe(customer);
    expect(lines.find((l) => l.account === "706")?.credit).toBe("1100000.0000");
    expect(lines.find((l) => l.account === "701")?.credit).toBe("99999.0000");
    expect(lines.find((l) => l.account === "443")?.credit).toBe("198000.0000");
    expect(lines.find((l) => l.account === "443")?.vat_code).toBe("TVA18");
    // Émise : ni modification ni annulation ni double émission.
    await expect(invoicing.updateDraft(issued.id, { notes: "x" })).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(invoicing.cancel(issued.id)).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(invoicing.issue(issued.id)).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("refuse l'émission sans connecteur quand le pack exige la certification", async () => {
    const { invoicing } = services(ctxA, { certification: new NullConnector() });
    const draft = await invoicing.createDraft(invoiceInput());
    await expect(invoicing.issue(draft.id)).rejects.toMatchObject({ code: "CERTIFICATION_REQUIRED" });
    const still = await invoicing.get(draft.id);
    expect(still.status).toBe("DRAFT");
    await invoicing.cancel(draft.id);
  });

  it("refuse l'émission dans une période clôturée sans consommer de numéro", async () => {
    const { invoicing } = services(ctxA);
    const before = (await invoicing.issue((await invoicing.createDraft(invoiceInput())).id)).number!;
    const draft = await invoicing.createDraft(invoiceInput("2025-01-15", "2025-02-15"));
    await expect(invoicing.issue(draft.id)).rejects.toMatchObject({ code: "PERIOD_CLOSED" });
    expect((await invoicing.get(draft.id)).status).toBe("DRAFT");
    const after = (await invoicing.issue((await invoicing.createDraft(invoiceInput())).id)).number!;
    expect(Number(after.slice(-4))).toBe(Number(before.slice(-4)) + 1);
  });

  it("numérotation continue et sans trou même quand un brouillon est annulé", async () => {
    const { invoicing } = services(ctxA);
    const a = await invoicing.createDraft(invoiceInput());
    const b = await invoicing.createDraft(invoiceInput());
    const c = await invoicing.createDraft(invoiceInput());
    await invoicing.cancel(a.id);
    const nb = (await invoicing.issue(b.id)).number!;
    const nc = (await invoicing.issue(c.id)).number!;
    expect(Number(nc.slice(-4))).toBe(Number(nb.slice(-4)) + 1);
    const numbers = (await invoicing.list({ kind: "INVOICE" })).map((d) => d.number).filter((n): n is string => n !== null).map((n) => Number(n.slice(-4))).sort((x, y) => x - y);
    numbers.forEach((n, i) => expect(n).toBe(i + 1));
    expect((await invoicing.get(a.id)).status).toBe("CANCELLED");
    // Les devis ont leur propre séquence.
    const q = await invoicing.issue((await invoicing.createDraft({ ...invoiceInput(), kind: "QUOTE" })).id);
    expect(q.number).toBe("DEV-2025-0001");
    expect(q.entryId).toBeNull();
  });

  it("devis → facture, puis avoir qui contrepasse par une nouvelle écriture", async () => {
    const { invoicing } = services(ctxA);
    const quote = await invoicing.issue((await invoicing.createDraft({ ...invoiceInput(), kind: "QUOTE" })).id);
    const invoice = await invoicing.issue((await invoicing.convertQuote(quote.id, { issueDate: "2025-03-20", dueDate: "2025-04-19" })).id);
    expect(invoice.sourceDocumentId).toBe(quote.id);
    expect((await invoicing.get(quote.id)).status).toBe("ACCEPTED");
    expect(invoice.totalGross.toString()).toBe(quote.totalGross.toString());

    const cn = await invoicing.issue((await invoicing.createCreditNote(invoice.id, { issueDate: "2025-03-25" })).id);
    expect(cn.kind).toBe("CREDIT_NOTE");
    expect(cn.number).toMatch(/^AV-2025-/);
    const { entry, lines } = await entryOf(cn.entryId!);
    expect(entry.journal_code).toBe("VT");
    expectBalanced(lines as never);
    expect(lines.find((l) => l.account === "411")?.credit).toBe(invoice.totalGross.toString());
    expect(lines.find((l) => l.account === "443")?.debit).toBe(invoice.totalVat.toString());
    const corrected = await invoicing.get(invoice.id);
    expect(corrected.creditedAmount.toString()).toBe(invoice.totalGross.toString());
    expect(corrected.outstanding.isZero()).toBe(true);
    expect(corrected.status).toBe("PAID");
    // Un avoir sur un brouillon est refusé.
    const d = await invoicing.createDraft(invoiceInput());
    await expect(invoicing.createCreditNote(d.id, { issueDate: "2025-03-25" })).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("données PDF : dossier, tiers, récapitulatif TVA, certification", async () => {
    const { invoicing } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft(invoiceInput())).id);
    const pdf = await invoicing.getPdfData(inv.id);
    expect(pdf.company.name).toBe("A");
    expect(pdf.partner.name).toBe("Client Alpha");
    expect(pdf.vatSummary.map((v) => v.vatCode)).toEqual(["TVA18", "EXO"]);
    expect(pdf.certification?.reference).toBe(inv.certification?.reference);
  });
});

run("règlements", () => {
  it("encaissement total : 521 à 411, statut PAID", async () => {
    const { invoicing, payments } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft(invoiceInput())).id);
    const p = await payments.record({ kind: "RECEIPT", method: "BANK", partnerId: customer, amount: inv.totalGross.toString(), date: "2025-04-02", reference: "VIR 123", allocations: [{ salesDocumentId: inv.id, amount: inv.totalGross.toString() }] });
    expect(p.status).toBe("RECORDED");
    expect(p.number).toMatch(/^REG-2025-/);
    expect(p.treasuryAccountNumber).toBe("521");
    const { entry, lines } = await entryOf(p.entryId!);
    expect(entry.journal_code).toBe("BQ");
    expectBalanced(lines as never);
    expect(lines.find((l) => l.account === "521")?.debit).toBe(inv.totalGross.toString());
    expect(lines.find((l) => l.account === "411")?.credit).toBe(inv.totalGross.toString());
    const paid = await invoicing.get(inv.id);
    expect(paid.status).toBe("PAID");
    expect(paid.paidAmount.toString()).toBe(inv.totalGross.toString());
    expect(paid.outstanding.isZero()).toBe(true);
  });

  it("règlement partiel puis solde en caisse ; sur-affectation refusée", async () => {
    const { invoicing, payments } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft(invoiceInput())).id);
    const p1 = await payments.record({ kind: "RECEIPT", method: "CASH", partnerId: customer, amount: "400000", date: "2025-04-03", allocations: [{ salesDocumentId: inv.id, amount: "400000" }] });
    expect((await entryOf(p1.entryId!)).entry.journal_code).toBe("CA");
    let doc = await invoicing.get(inv.id);
    expect(doc.status).toBe("PARTIALLY_PAID");
    expect(doc.outstanding.toString()).toBe(inv.totalGross.sub(Money.parse("400000")).toString());
    await expect(payments.record({ kind: "RECEIPT", method: "CASH", partnerId: customer, amount: "2000000", date: "2025-04-04", allocations: [{ salesDocumentId: inv.id, amount: "2000000" }] })).rejects.toMatchObject({ code: "OVER_ALLOCATION" });
    // Règlement non affecté puis affectation a posteriori.
    const p2 = await payments.record({ kind: "RECEIPT", method: "MOBILE_MONEY", partnerId: customer, amount: doc.outstanding.toString(), date: "2025-04-05" });
    expect(p2.treasuryAccountNumber).toBe("5381");
    expect(p2.allocated.isZero()).toBe(true);
    const p2b = await payments.allocate(p2.id, [{ salesDocumentId: inv.id, amount: doc.outstanding.toString() }]);
    expect(p2b.allocated.toString()).toBe(doc.outstanding.toString());
    doc = await invoicing.get(inv.id);
    expect(doc.status).toBe("PAID");
    await expect(payments.record({ kind: "RECEIPT", method: "BANK", partnerId: supplier, amount: "10", date: "2025-04-05", allocations: [{ salesDocumentId: inv.id, amount: "10" }] })).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("séparation des tâches : au-delà du seuil, approbation par un autre utilisateur avant toute écriture", async () => {
    const { invoicing, payments } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft({ ...invoiceInput(), lines: [{ label: "Gros contrat", quantity: "1", unitPrice: "5000000", accountNumber: "706", vatCode: "TVA18" }] })).id);
    const p = await payments.record({ kind: "RECEIPT", method: "BANK", partnerId: customer, amount: inv.totalGross.toString(), date: "2025-04-06", allocations: [{ salesDocumentId: inv.id, amount: inv.totalGross.toString() }] });
    expect(p.status).toBe("PENDING_APPROVAL");
    expect(p.entryId).toBeNull();
    expect((await invoicing.get(inv.id)).status).toBe("SENT"); // rien n'est appliqué avant approbation
    await expect(payments.approve(p.id)).rejects.toMatchObject({ code: "SAME_USER" });
    await expect(payments.allocate(p.id, [])).rejects.toMatchObject({ code: "INVALID_STATUS" });
    const approved = await services(ctxB).payments.approve(p.id);
    expect(approved.status).toBe("RECORDED");
    expect(approved.approvedBy).toBe(userB);
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.entryId).toBeTruthy();
    expectBalanced((await entryOf(approved.entryId!)).lines as never);
    expect((await invoicing.get(inv.id)).status).toBe("PAID");
    await expect(services(ctxB).payments.approve(p.id)).rejects.toMatchObject({ code: "INVALID_STATUS" });
    // Refus d'un règlement en attente : jamais comptabilisé.
    const p2 = await payments.record({ kind: "RECEIPT", method: "BANK", partnerId: customer, amount: "6000000", date: "2025-04-06" });
    const rejected = await services(ctxB).payments.reject(p2.id, "montant non reçu");
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.entryId).toBeNull();
  });

  it("l'approbateur ne peut pas avoir saisi le document d'achat réglé", async () => {
    const { purchases, payments } = services(ctxA);
    const big = await purchases.issue((await purchases.createDraft({ kind: "SUPPLIER_INVOICE", partnerId: supplier, reference: "FF-BIG", issueDate: "2025-05-02", lines: [{ accountNumber: "622", label: "Loyer annuel", net: "6000000", vatCode: "TVA18" }] })).id);
    // Règlement saisi par B (dirigeant), document saisi par A : A ne peut pas approuver.
    const p = await services(ctxB).payments.record({ kind: "DISBURSEMENT", method: "BANK", partnerId: supplier, amount: big.totalGross.toString(), date: "2025-05-10", allocations: [{ purchaseDocumentId: big.id, amount: big.totalGross.toString() }] });
    expect(p.status).toBe("PENDING_APPROVAL");
    await expect(payments.approve(p.id)).rejects.toMatchObject({ code: "SAME_USER" });
    await expect(services(ctxB).payments.approve(p.id)).rejects.toMatchObject({ code: "SAME_USER" });
    // Un troisième utilisateur approuve.
    const [uc] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'c@t.t', 'Associé') RETURNING id`;
    const approved = await services({ ...ctxA, userId: uc!.id as string }).payments.approve(p.id);
    expect(approved.status).toBe("RECORDED");
    expect((await purchases.get(big.id)).status).toBe("PAID");
  });
});

run("achats", () => {
  it("facture fournisseur : 6xx / 445 à 401, puis décaissement", async () => {
    const { purchases, payments } = services(ctxA);
    const draft = await purchases.createDraft({
      kind: "SUPPLIER_INVOICE",
      partnerId: supplier,
      reference: "FF-0042",
      issueDate: "2025-03-20",
      dueDate: "2025-04-20",
      lines: [
        { accountNumber: "622", label: "Loyer mars", net: "400000", vatCode: "TVA18" },
        { accountNumber: "6055", label: "Fournitures", net: "33333", vatCode: "TVA18" },
      ],
    });
    expect(draft.totalVat.toString()).toBe("78000.0000");
    const posted = await purchases.issue(draft.id);
    expect(posted.status).toBe("POSTED");
    expect(posted.number).toMatch(/^FF-2025-\d{4}$/);
    const { entry, lines } = await entryOf(posted.entryId!);
    expect(entry.journal_code).toBe("AC");
    expect(entry.reference).toBe("FF-0042");
    expectBalanced(lines as never);
    expect(lines.find((l) => l.account === "622")?.debit).toBe("400000.0000");
    expect(lines.find((l) => l.account === "445")?.debit).toBe("78000.0000");
    expect(lines.find((l) => l.account === "401")?.credit).toBe("511333.0000");
    const p = await payments.record({ kind: "DISBURSEMENT", method: "BANK", partnerId: supplier, amount: "511333", date: "2025-04-10", allocations: [{ purchaseDocumentId: posted.id, amount: "511333" }] });
    const pl = (await entryOf(p.entryId!)).lines;
    expect(pl.find((l) => l.account === "401")?.debit).toBe("511333.0000");
    expect(pl.find((l) => l.account === "521")?.credit).toBe("511333.0000");
    expect((await purchases.get(posted.id)).status).toBe("PAID");
    await expect(purchases.cancel(posted.id)).rejects.toMatchObject({ code: "INVALID_STATUS" });
    // Avoir fournisseur.
    const cn = await purchases.issue((await purchases.createCreditNote(posted.id, { issueDate: "2025-04-11", lines: [{ accountNumber: "622", label: "Remise loyer", net: "50000", vatCode: "TVA18" }] })).id);
    expect(cn.number).toBe("AF-2025-0001");
    const cl = (await entryOf(cn.entryId!)).lines;
    expect(cl.find((l) => l.account === "401")?.debit).toBe("59000.0000");
    expect(cl.find((l) => l.account === "445")?.credit).toBe("9000.0000");
  });

  it("note de frais : charges à 421 salarié ; tiers et comptes contrôlés", async () => {
    const { purchases } = services(ctxA);
    const claim = await purchases.issue((await purchases.createDraft({ kind: "EXPENSE_CLAIM", partnerId: employee, issueDate: "2025-03-28", lines: [{ accountNumber: "614", label: "Taxi", net: "15000" }, { accountNumber: "638", label: "Repas", net: "20000", vatCode: "TVA18" }] })).id);
    expect(claim.number).toBe("NDF-2025-0001");
    const { lines } = await entryOf(claim.entryId!);
    expectBalanced(lines as never);
    expect(lines.find((l) => l.account === "421")?.credit).toBe("38600.0000");
    expect(lines.find((l) => l.account === "421")?.partner_id).toBe(employee);
    await expect(purchases.createDraft({ kind: "EXPENSE_CLAIM", partnerId: supplier, issueDate: "2025-03-28", lines: [{ accountNumber: "614", label: "x", net: "1" }] })).rejects.toMatchObject({ code: "PARTNER_MISMATCH" });
    await expect(purchases.createDraft({ kind: "SUPPLIER_INVOICE", partnerId: supplier, issueDate: "2025-03-28", lines: [{ accountNumber: "706", label: "x", net: "1" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(purchases.issue((await purchases.createDraft({ kind: "SUPPLIER_INVOICE", partnerId: supplier, issueDate: "2025-01-10", lines: [{ accountNumber: "622", label: "x", net: "1" }] })).id)).rejects.toMatchObject({ code: "PERIOD_CLOSED" });
  });
});

run("mobile money : lien et webhook signé", () => {
  it("confirmation signée → règlement 5381 à 411, facture PAID, doublon sans effet", async () => {
    const { invoicing, payments } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft({ ...invoiceInput(), lines: [{ label: "Abonnement", quantity: "1", unitPrice: "50000", accountNumber: "706", vatCode: "TVA18" }] })).id);
    const link = await payments.createPaymentLink(inv.id, "mock");
    expect(link.amount.toString()).toBe("59000.0000");
    expect(link.url).toContain(link.providerRef);
    const delivery = mobile.signedDelivery(link.providerRef);
    const first = await payments.handleWebhook("mock", delivery.rawBody, delivery.headers);
    expect(first.outcome).toBe("processed");
    expect(first.payment?.status).toBe("RECORDED");
    expect(first.payment?.method).toBe("MOBILE_MONEY");
    expect(first.payment?.providerEventId).toBeTruthy();
    const { lines } = await entryOf(first.payment!.entryId!);
    expect(lines.find((l) => l.account === "5381")?.debit).toBe("59000.0000");
    expect((await invoicing.get(inv.id)).status).toBe("PAID");
    expect((await payments.listPaymentLinks(inv.id))[0]?.status).toBe("PAID");
    // Même événement relivré (même nonce et même identifiant) : idempotent.
    const again = await payments.handleWebhook("mock", delivery.rawBody, delivery.headers);
    expect(again.outcome).toBe("duplicate");
    expect(again.payment?.id).toBe(first.payment?.id);
    expect((await payments.list({ partnerId: customer })).filter((p) => p.providerEventId === first.payment?.providerEventId)).toHaveLength(1);
  });

  it("signature invalide → 401 et tentative journalisée ; rejeu (nonce, horodatage) refusé", async () => {
    const { invoicing, payments } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft({ ...invoiceInput(), lines: [{ label: "Abonnement", quantity: "1", unitPrice: "50000", accountNumber: "706", vatCode: "TVA18" }] })).id);
    const link = await payments.createPaymentLink(inv.id, "mock");
    const forged = mobile.signedDelivery(link.providerRef, {}, { secret: "wrong" });
    const err = await payments.handleWebhook("mock", forged.rawBody, forged.headers).catch((e) => e as InvoicingError);
    expect(err).toBeInstanceOf(InvoicingError);
    expect((err as InvoicingError).code).toBe("INVALID_SIGNATURE");
    expect((err as InvoicingError).httpStatus).toBe(401);
    const [attack] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT * FROM audit_log WHERE tenant_id = ${tenantA} AND action = 'webhook.invalid_signature' ORDER BY id DESC LIMIT 1`);
    expect(attack).toBeDefined();
    // Corps altéré sous une signature valide d'un autre corps.
    const good = mobile.signedDelivery(link.providerRef);
    await expect(payments.handleWebhook("mock", good.rawBody.replace('"PAID"', '"PAID "'), good.headers)).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    // Horodatage trop ancien.
    const stale = mobile.signedDelivery(link.providerRef, {}, { timestamp: Math.floor(NOW.getTime() / 1000) - 3600 });
    await expect(payments.handleWebhook("mock", stale.rawBody, stale.headers)).rejects.toMatchObject({ code: "REPLAY" });
    // Nonce réutilisé avec un autre identifiant d'événement.
    const ok = await payments.handleWebhook("mock", good.rawBody, good.headers);
    expect(ok.outcome).toBe("processed");
    const replay = mobile.signedDelivery(link.providerRef, { eventId: "EVT-other" }, { nonce: good.headers["x-nonce"]! });
    await expect(payments.handleWebhook("mock", replay.rawBody, replay.headers)).rejects.toMatchObject({ code: "REPLAY" });
    const replays = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantA} AND action = 'webhook.replay'`);
    expect(Number(replays[0]?.n)).toBeGreaterThanOrEqual(2);
    expect((await invoicing.get(inv.id)).status).toBe("PAID");
    await expect(payments.handleWebhook("nope", "{}", {})).rejects.toMatchObject({ code: "PROVIDER_UNKNOWN" });
  });

  it("écart montant reçu / attendu → règlement en REVIEW, jamais d'écriture automatique", async () => {
    const { invoicing, payments } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft({ ...invoiceInput(), lines: [{ label: "Abonnement", quantity: "1", unitPrice: "50000", accountNumber: "706", vatCode: "TVA18" }] })).id);
    const link = await payments.createPaymentLink(inv.id, "mock");
    const short = mobile.signedDelivery(link.providerRef, { amount: "50000" });
    const res = await payments.handleWebhook("mock", short.rawBody, short.headers);
    expect(res.outcome).toBe("review");
    expect(res.payment?.status).toBe("REVIEW");
    expect(res.payment?.entryId).toBeNull();
    expect(res.payment?.reviewReason).toContain("50000");
    expect((await invoicing.get(inv.id)).status).toBe("SENT");
    // Revue humaine par un autre utilisateur : comptabilisé sur la base du montant réellement reçu.
    const approved = await services(ctxB).payments.approve(res.payment!.id);
    expect(approved.status).toBe("RECORDED");
    expect((await invoicing.get(inv.id)).status).toBe("PARTIALLY_PAID");
  });
});

run("isolation, balance âgée, relances", () => {
  it("un autre dossier ne voit rien (RLS)", async () => {
    const { invoicing, payments, purchases } = services(ctxA);
    const inv = await invoicing.issue((await invoicing.createDraft(invoiceInput())).id);
    const other = services(ctxOther);
    expect(await other.invoicing.list()).toEqual([]);
    expect(await other.payments.list()).toEqual([]);
    expect(await other.purchases.list()).toEqual([]);
    expect(await other.invoicing.listProducts({ includeInactive: true })).toEqual([]);
    await expect(other.invoicing.get(inv.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.invoicing.issue(inv.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.payments.record({ kind: "RECEIPT", method: "BANK", partnerId: customer, amount: "1", date: "2025-04-01" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await other.invoicing.getAgedReceivables("2025-12-31")).rows).toEqual([]);
    void payments;
    void purchases;
  });

  it("balance âgée des créances par tranche 0-30 / 31-60 / 61-90 / 90+", async () => {
    // Dossier dédié pour un résultat déterministe.
    const tenantC = (await seedCompany(db, { organizationId: orgId, name: "C", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" } })).companyId;
    const [c1] = await withTenant(db, { tenantId: tenantC }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account, contact) VALUES (${tenantC}, 'CUSTOMER', 'Gamma', '411', '{"email": "gamma@client.test"}') RETURNING id`);
    const [c2] = await withTenant(db, { tenantId: tenantC }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account, contact) VALUES (${tenantC}, 'CUSTOMER', 'Delta', '411', '{"email": "delta@client.test", "whatsapp": "+2250700000002"}') RETURNING id`);
    const dunningSender = new MemoryDunningSender();
    const { invoicing, payments } = services({ tenantId: tenantC, userId: userA, organizationId: orgId }, { dunningSender });
    const mk = async (partnerId: string, issue: string, due: string, price: string) =>
      invoicing.issue((await invoicing.createDraft({ kind: "INVOICE", partnerId, issueDate: issue, dueDate: due, lines: [{ label: "L", quantity: "1", unitPrice: price, accountNumber: "706", vatCode: "EXO" }] })).id);
    const asOf = "2025-10-01";
    await mk(c1!.id as string, "2025-09-01", "2025-09-20", "100"); // 11 jours → 0-30
    await mk(c1!.id as string, "2025-08-01", "2025-08-10", "200"); // 52 jours → 31-60
    const half = await mk(c2!.id as string, "2025-07-01", "2025-07-15", "400"); // 78 jours → 61-90, réglée à moitié
    await mk(c2!.id as string, "2025-05-01", "2025-05-15", "800"); // 139 jours → 90+
    await mk(c1!.id as string, "2025-10-05", "2025-11-05", "999"); // postérieure à asOf : exclue
    const paid = await mk(c2!.id as string, "2025-06-01", "2025-06-15", "50");
    await payments.record({ kind: "RECEIPT", method: "CASH", partnerId: c2!.id as string, amount: "250", date: "2025-09-30", allocations: [{ salesDocumentId: half.id, amount: "200" }, { salesDocumentId: paid.id, amount: "50" }] });

    const report = await invoicing.getAgedReceivables(asOf);
    expect(report.totals["0-30"].toString()).toBe("100.0000");
    expect(report.totals["31-60"].toString()).toBe("200.0000");
    expect(report.totals["61-90"].toString()).toBe("200.0000");
    expect(report.totals["90+"].toString()).toBe("800.0000");
    expect(report.total.toString()).toBe("1300.0000");
    const gamma = report.rows.find((r) => r.partnerName === "Gamma")!;
    expect(gamma.total.toString()).toBe("300.0000");
    expect(gamma.documents).toBe(2);
    const delta = report.rows.find((r) => r.partnerName === "Delta")!;
    expect(delta.buckets["61-90"].toString()).toBe("200.0000");
    expect(report.rows[0]?.partnerName).toBe("Delta"); // tri par total décroissant
    expect([agingBucket(0), agingBucket(30), agingBucket(31), agingBucket(60), agingBucket(61), agingBucket(90), agingBucket(91)]).toEqual(["0-30", "0-30", "31-60", "31-60", "61-90", "61-90", "90+"]);

    // Relances : factures échues, niveau suggéré, journal des envois.
    const overdue = await invoicing.listOverdue(asOf);
    expect(overdue.map((o) => o.outstanding.toString())).toEqual(["800.0000", "200.0000", "200.0000", "100.0000"]);
    expect(overdue[0]?.daysOverdue).toBe(139);
    expect(overdue[0]?.suggestedLevel).toBe(1);
    await invoicing.recordDunning(overdue[0]!.documentId, { level: 1, channel: "WHATSAPP", message: "Rappel" });
    // La ligne n'est écrite qu'après remise au canal : l'expéditeur a bien reçu
    // la facture, le destinataire et le reste dû.
    expect(dunningSender.last()).toMatchObject({
      channel: "WHATSAPP",
      level: 1,
      recipient: "+2250700000002",
      partnerName: "Delta",
      companyName: "C",
      outstanding: "800.0000",
      currency: "XOF",
      dueDate: "2025-05-15",
      message: "Rappel",
    });
    const after = await invoicing.listOverdue(asOf);
    expect(after[0]?.lastDunningLevel).toBe(1);
    expect(after[0]?.suggestedLevel).toBe(2);
    await expect(invoicing.recordDunning(paid.id, { level: 1, channel: "EMAIL" })).rejects.toMatchObject({ code: "INVALID_STATUS" });

    // Envoi en échec : rien n'est enregistré comme envoyé, mais la tentative
    // reste dans dunning_log — on perd l'envoi, jamais sa trace.
    dunningSender.failNext = true;
    await expect(invoicing.recordDunning(overdue[1]!.documentId, { level: 1, channel: "EMAIL" })).rejects.toMatchObject({ code: "DUNNING_NOT_SENT" });
    expect((await invoicing.listOverdue(asOf))[1]?.lastDunningLevel).toBe(0);

    // Sans contact pour le canal demandé, la relance n'a pas de destinataire.
    await expect(invoicing.recordDunning(overdue[3]!.documentId, { level: 1, channel: "WHATSAPP" })).rejects.toMatchObject({ code: "VALIDATION" });

    // Sans expéditeur branché, on refuse plutôt que d'enregistrer un envoi imaginaire.
    const muet = services({ tenantId: tenantC, userId: userA, organizationId: orgId }).invoicing;
    await expect(muet.recordDunning(overdue[3]!.documentId, { level: 1, channel: "EMAIL" })).rejects.toMatchObject({ code: "DUNNING_NOT_SENT" });
    expect((await invoicing.listOverdue(asOf))[3]?.lastDunningLevel).toBe(0);

    const journal = await withTenant(db, { tenantId: tenantC }, (tx) => tx`SELECT status, level, channel, reference FROM dunning_log WHERE tenant_id = ${tenantC} ORDER BY sent_at`);
    expect(journal.map((r) => r.status)).toEqual(["SENT", "FAILED", "FAILED"]);
  });
});
