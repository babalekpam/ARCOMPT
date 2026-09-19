import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { createTestDatabase } from "@arcompt/db/testing";
import { Ledger, PostgresStore, type Actor } from "@arcompt/ledger";
import type { LlmMatcher, LlmMatchRequest } from "./llm-matcher.js";
import { TreasuryService } from "./service.js";
import type { TreasuryAccount } from "./types.js";

/**
 * Tests d'intégration du module trésorerie : import de relevé, rapprochement,
 * écritures dérivées via Ledger.post, rapport, caisse, isolation RLS.
 * Ignorés sans DATABASE_URL.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let appDb: Db;
let orgId: string;
let userId: string;
let tenantA: string;
let tenantB: string;
let actorA: Actor;
let ledgerA: Ledger;
let svcA: TreasuryService;
let svcB: TreasuryService;
let clientA: string;
let supplierA: string;
let bank: TreasuryAccount;
let cash: TreasuryAccount;
let statementId: string;

/** Mock LLM : réponse fixée par test. */
class FakeMatcher implements LlmMatcher {
  readonly requests: LlmMatchRequest[] = [];
  constructor(private readonly answer: (req: LlmMatchRequest) => { lineId: string | null; confidence: number }) {}
  async match(_ctx: { tenantId: string }, req: LlmMatchRequest) {
    this.requests.push(req);
    return this.answer(req);
  }
}

const service = (tenantId: string, extra: Partial<ConstructorParameters<typeof TreasuryService>[0]> = {}) =>
  new TreasuryService({
    db: appDb as unknown as Sql,
    ledger: new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" }),
    ctx: { tenantId, userId, organizationId: orgId },
    ...extra,
  });

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 't@t.t', 'T') RETURNING id`;
  userId = u!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "SN", currency: "XOF", packVersion: "sn@2025.1", fiscalYear: fy })).companyId;
  const partners = await withTenant(db, { tenantId: tenantA }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Client Alpha', '411'), (${tenantA}, 'SUPPLIER', 'Fournisseur Bêta', '401') RETURNING id, type`,
  );
  clientA = partners.find((p) => p.type === "CUSTOMER")!.id as string;
  supplierA = partners.find((p) => p.type === "SUPPLIER")!.id as string;
  actorA = { userId, tenantId: tenantA };
  ledgerA = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  svcA = service(tenantA);
  svcB = service(tenantB);
});

afterAll(async () => {
  await env?.drop();
});

const CSV = [
  "Date;Libellé;Débit;Crédit;Référence",
  "05/03/2025;VIR CLIENT ALPHA FAC-2025-001;;1 180 000;VIR001",
  "06/03/2025;FRAIS TENUE DE COMPTE;5 000;;",
  "10/03/2025;VIR FOURNISSEUR BETA FF-0042;472 000;;VIR002",
  "12/03/2025;REMISE CHQ 12345;;250 000;",
  "12/03/2025;REMISE CHQ 12346;;250 000;",
  "20/03/2025;COMMISSION VIREMENT;1 500;;",
].join("\n");

run("Trésorerie — comptes", () => {
  it("crée des comptes banque et caisse rattachés au plan ; refuse un compte hors classe 5 ou inconnu", async () => {
    bank = await svcA.createAccount({ kind: "BANK", label: "SGBCI courant", accountNumber: "521", currency: "xof", bankName: "SGBCI", iban: "CI93CI0080111301134291200589" });
    cash = await svcA.createAccount({ kind: "CASH", label: "Caisse siège", accountNumber: "571", currency: "XOF" });
    expect(bank.currency).toBe("XOF");
    expect(bank.bankName).toBe("SGBCI");
    await expect(svcA.createAccount({ kind: "BANK", label: "x", accountNumber: "411", currency: "XOF" })).rejects.toMatchObject({ code: "UNKNOWN_CHART_ACCOUNT" });
    await expect(svcA.createAccount({ kind: "BANK", label: "x", accountNumber: "52", currency: "XOF" })).rejects.toMatchObject({ code: "UNKNOWN_CHART_ACCOUNT" });
    expect((await svcA.listAccounts()).map((a) => a.accountNumber)).toEqual(["521", "571"]);
    const mm = await svcA.createAccount({ kind: "MOBILE_MONEY", label: "Orange Money", accountNumber: "5381", currency: "XOF", mmOperator: "Orange", mmPhone: "0707070707" });
    expect((await svcA.deleteAccount(mm.id)).deleted).toBe(true);
    await expect(svcA.getAccount(mm.id)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
});

run("Trésorerie — import de relevé", () => {
  it("importe un CSV, calcule la période et le solde de clôture, refuse un second import identique", async () => {
    const result = await svcA.importStatement(bank.id, { csv: CSV }, { openingBalance: "0" });
    statementId = result.statement.id;
    expect(result.imported).toBe(6);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.parseErrors).toEqual([]);
    expect(result.rowsInClosedPeriods).toBe(0);
    expect(result.statement).toMatchObject({ periodFrom: "2025-03-05", periodTo: "2025-03-20", source: "CSV" });
    expect(result.statement.closingBalance!.toString()).toBe("1201500.0000");
    await expect(svcA.importStatement(bank.id, { csv: CSV }, { openingBalance: "0" })).rejects.toMatchObject({ code: "DUPLICATE_STATEMENT" });
    const txs = await svcA.listTransactions(statementId);
    expect(txs).toHaveLength(6);
    expect(txs.every((t) => t.status === "UNMATCHED")).toBe(true);
    expect(txs[0]!.amount.toString()).toBe("1180000.0000");
  });

  it("ignore les lignes déjà présentes (date, montant, libellé) et refuse un relevé vide", async () => {
    const again = await svcA.importStatement(
      bank.id,
      { rows: [{ date: "2025-03-06", label: "Frais tenue de compte", amount: "-5000" }, { date: "2025-03-25", label: "AGIOS", amount: "-800", externalId: "AG1" }] },
      { source: "API" },
    );
    expect(again.imported).toBe(1);
    expect(again.skippedDuplicates).toBe(1);
    // Le solde d'ouverture s'enchaîne sur la clôture du relevé précédent.
    expect(again.statement.openingBalance!.toString()).toBe("1201500.0000");
    expect(again.statement.closingBalance!.toString()).toBe("1200700.0000");
    // Même identifiant externe sous un autre libellé : doublon ; un relevé dont toutes les lignes existent n'est pas créé.
    await expect(svcA.importStatement(bank.id, { rows: [{ date: "2025-03-25", label: "autre libellé", amount: "-800", externalId: "AG1" }] }, { source: "API" })).rejects.toMatchObject({
      code: "DUPLICATE_STATEMENT",
      details: { skippedDuplicates: 1 },
    });
    expect(await svcA.listStatements(bank.id)).toHaveLength(2);
    await expect(svcA.importStatement(bank.id, { rows: [] })).rejects.toMatchObject({ code: "EMPTY_STATEMENT" });
    await expect(svcA.importStatement(bank.id, { csv: "a;b\n1;2" })).rejects.toMatchObject({ code: "PARSE_ERROR" });
    await expect(svcA.importStatement(bank.id, { rows: [{ date: "2025-03-25", label: "x", amount: "0" }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("importe des SMS mobile money", async () => {
    const mm = await svcA.createAccount({ kind: "MOBILE_MONEY", label: "Orange Money", accountNumber: "5381", currency: "XOF", mmOperator: "Orange" });
    const sms = "Vous avez reçu 25 000 FCFA de KOUAME YAO le 15/03/2025. Ref: PP1. Nouveau solde: 125 000 FCFA.\n\nVous avez envoyé 10 000 FCFA à AKISSI le 16/03/2025. Frais: 100 FCFA. Ref: PP2.\n\nCode promo: 1234";
    const r = await svcA.importStatement(mm.id, { sms }, {});
    expect(r.imported).toBe(3);
    expect(r.unparsed).toEqual(["Code promo: 1234"]);
    expect(r.statement.source).toBe("SMS");
    expect(r.statement.closingBalance).toBeNull();
  });
});

run("Trésorerie — rapprochement", () => {
  it("apparie les montants exacts, laisse les ambigus et les inconnus en attente", async () => {
    await ledgerA.post(actorA, {
      journalCode: "BQ",
      date: "2025-03-05",
      reference: "FAC-2025-001",
      label: "Règlement Client Alpha",
      source: "BANK",
      lines: [
        { accountNumber: "521", debit: "1180000" },
        { accountNumber: "411", credit: "1180000", partnerId: clientA },
      ],
    });
    await ledgerA.post(actorA, {
      journalCode: "BQ",
      date: "2025-03-11",
      label: "Paiement Fournisseur Bêta",
      source: "BANK",
      lines: [
        { accountNumber: "401", debit: "472000", partnerId: supplierA },
        { accountNumber: "521", credit: "472000" },
      ],
    });
    for (let i = 0; i < 2; i++) {
      await ledgerA.post(actorA, {
        journalCode: "BQ",
        date: "2025-03-12",
        label: "Remise chèques",
        source: "BANK",
        lines: [
          { accountNumber: "521", debit: "250000" },
          { accountNumber: "411", credit: "250000", partnerId: clientA },
        ],
      });
    }
    // Un brouillon n'est jamais candidat.
    await ledgerA.createDraft(actorA, {
      journalCode: "BQ",
      date: "2025-03-06",
      label: "Frais brouillon",
      source: "BANK",
      lines: [
        { accountNumber: "631", debit: "5000" },
        { accountNumber: "521", credit: "5000" },
      ],
    });

    const result = await svcA.autoMatch(statementId);
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(4);
    expect(result.llmConsulted).toBe(0);
    const txs = await svcA.listTransactions(statementId);
    const byLabel = Object.fromEntries(txs.map((t) => [t.label, t]));
    expect(byLabel["VIR CLIENT ALPHA FAC-2025-001"]).toMatchObject({ status: "MATCHED", matchMethod: "AMOUNT_DATE" });
    expect(byLabel["VIR CLIENT ALPHA FAC-2025-001"]!.matchConfidence).toBeGreaterThanOrEqual(0.9);
    expect(byLabel["VIR FOURNISSEUR BETA FF-0042"]).toMatchObject({ status: "MATCHED", matchMethod: "AMOUNT_DATE" });
    expect(byLabel["REMISE CHQ 12345"]!.status).toBe("UNMATCHED");
    expect(byLabel["REMISE CHQ 12346"]!.status).toBe("UNMATCHED");
    expect(byLabel["FRAIS TENUE DE COMPTE"]!.status).toBe("UNMATCHED");
    const reasons = Object.fromEntries(result.decisions.map((d) => [txs.find((t) => t.id === d.transactionId)!.label, d.reason]));
    expect(reasons["REMISE CHQ 12345"]).toBe("AMBIGUOUS");
    expect(reasons["FRAIS TENUE DE COMPTE"]).toBe("NO_CANDIDATE");
    // Une seconde passe ne change rien : les lignes prises ne sont plus candidates.
    expect((await svcA.autoMatch(statementId)).matched).toBe(0);
  });

  it("consulte le LLM pour les ambigus et n'apparie que si sa confiance atteint le seuil", async () => {
    const timid = new FakeMatcher((req) => ({ lineId: req.candidates[0]!.lineId, confidence: 0.6 }));
    const r1 = await service(tenantA, { llmMatcher: timid }).autoMatch(statementId);
    expect(r1.llmConsulted).toBe(2);
    expect(r1.matched).toBe(0);
    expect(timid.requests[0]!.candidates).toHaveLength(2);
    // Le seuil ne peut pas être abaissé sous le plancher.
    const r1b = await service(tenantA, { llmMatcher: timid, matchThreshold: 0.1 }).autoMatch(statementId, { threshold: 0.1 });
    expect(r1b.matched).toBe(0);

    const confident = new FakeMatcher((req) => ({ lineId: req.candidates[0]!.lineId, confidence: 0.95 }));
    const r2 = await service(tenantA, { llmMatcher: confident }).autoMatch(statementId);
    expect(r2.matched).toBe(2);
    expect(r2.llmConsulted).toBe(2);
    // Le second appel n'a vu qu'un seul candidat libre.
    expect(confident.requests[1]!.candidates).toHaveLength(1);
    const txs = await svcA.listTransactions(statementId, { status: "MATCHED" });
    expect(txs.filter((t) => t.matchMethod === "LLM")).toHaveLength(2);
    expect(new Set(txs.map((t) => t.matchedLineId)).size).toBe(txs.length);
  });

  it("comptabilise une ligne de relevé via Ledger.post (frais 631 / 521) et la rapproche ; règle → méthode RULE", async () => {
    const txs = await svcA.listTransactions(statementId, { status: "UNMATCHED" });
    const fees = txs.find((t) => t.label === "FRAIS TENUE DE COMPTE")!;
    const { entry, transaction } = await svcA.createEntryFromTransaction(fees.id, { accountNumber: "631" });
    expect(entry.status).toBe("VALIDATED");
    expect(entry.journalCode).toBe("BQ");
    expect(entry.date).toBe("2025-03-06");
    expect(entry.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["631", "5000.0000", "0.0000"],
      ["521", "0.0000", "5000.0000"],
    ]);
    expect(transaction).toMatchObject({ status: "MATCHED", matchMethod: "MANUAL", matchConfidence: 1 });
    expect(transaction.matchedLineId).toBe(entry.lines[1]!.id);

    const rule = await svcA.createRule({ pattern: "commission", accountNumber: "631", priority: 10 });
    const suggestion = (await svcA.autoMatch(statementId)).decisions.find((d) => d.suggestedRuleId);
    expect(suggestion).toMatchObject({ suggestedRuleId: rule.id, suggestedAccountNumber: "631" });
    const commission = txs.find((t) => t.label === "COMMISSION VIREMENT")!;
    const posted = await svcA.createEntryFromTransaction(commission.id, { accountNumber: rule.accountNumber, ruleId: rule.id });
    expect(posted.transaction.matchMethod).toBe("RULE");
    await expect(svcA.createEntryFromTransaction(commission.id, { accountNumber: "631" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Compte lettrable sans tiers : refus par le moteur, la ligne reste en attente.
    const agios = (await svcA.listTransactions((await svcA.listStatements(bank.id)).find((s) => s.source === "API")!.id))[0]!;
    await expect(svcA.createEntryFromTransaction(agios.id, { accountNumber: "401" })).rejects.toMatchObject({ code: "PARTNER_REQUIRED" });
    expect((await svcA.getTransaction(agios.id)).status).toBe("UNMATCHED");
  });

  it("rapprochement manuel : contrôle du compte, de l'état et du montant ; unmatch et ignore", async () => {
    const agios = (await svcA.listTransactions((await svcA.listStatements(bank.id)).find((s) => s.source === "API")!.id))[0]!;
    const entry = await ledgerA.post(actorA, {
      journalCode: "BQ",
      date: "2025-03-26",
      label: "Agios",
      source: "BANK",
      lines: [
        { accountNumber: "631", debit: "800" },
        { accountNumber: "521", credit: "800" },
      ],
    });
    const wrongAccount = entry.lines[0]!.id;
    const bankLine = entry.lines[1]!.id;
    await expect(svcA.manualMatch(agios.id, wrongAccount)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const other = await ledgerA.post(actorA, {
      journalCode: "BQ",
      date: "2025-03-26",
      label: "Autre",
      source: "BANK",
      lines: [
        { accountNumber: "631", debit: "900" },
        { accountNumber: "521", credit: "900" },
      ],
    });
    await expect(svcA.manualMatch(agios.id, other.lines[1]!.id)).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(await svcA.candidateLines(agios.id)).toHaveLength(1);
    const matched = await svcA.manualMatch(agios.id, bankLine);
    expect(matched).toMatchObject({ status: "MATCHED", matchMethod: "MANUAL", matchedLineId: bankLine });
    await expect(svcA.manualMatch(agios.id, bankLine)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const back = await svcA.unmatch(agios.id);
    expect(back).toMatchObject({ status: "UNMATCHED", matchedLineId: null, matchMethod: null });
    const ignored = await svcA.ignore(agios.id);
    expect(ignored.status).toBe("IGNORED");
    await expect(svcA.ignore(agios.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await svcA.unmatch(agios.id)).status).toBe("UNMATCHED");
    await svcA.manualMatch(agios.id, bankLine);
  });

  it("produit un rapport de rapprochement équilibré, avec les éléments en suspens", async () => {
    const report = await svcA.reconciliationReport(bank.id, "2025-03-31");
    // Comptabilité 521 : +1180000 −472000 +250000 +250000 −5000 −1500 −800 −900 = 1 199 800.
    // Dernier relevé clos : 1 200 700 ; « Autre » (−900) est en compta mais pas sur le relevé.
    expect(report.bookBalance).toBe("1199800.0000");
    expect(report.statementBalance).toBe("1200700.0000");
    expect(report.reconciledFrom).toBe("2025-03-05");
    expect(report.unbookedTransactions).toEqual([]);
    expect(report.unclearedLines).toHaveLength(1);
    expect(report.unclearedLines[0]).toMatchObject({ amount: "-900.0000", label: "Autre" });
    expect(report.adjustedBookBalance).toBe("1199800.0000");
    expect(report.adjustedStatementBalance).toBe("1199800.0000");
    expect(report.difference).toBe("0.0000");
    expect(report.balanced).toBe(true);
    expect(report.ignoredTransactions).toBe(0);
    // Une contrepassation ajoute une ligne en suspens de sens inverse ; le rapport reste équilibré.
    await ledgerA.reverse(actorA, await findEntryByLabel("Autre"), { date: "2025-03-27" });
    const after = await svcA.reconciliationReport(bank.id, "2025-03-31");
    expect(after.bookBalance).toBe("1200700.0000");
    expect(after.unclearedLines.map((l) => l.amount).sort()).toEqual(["-900.0000", "900.0000"]);
    expect(after.balanced).toBe(true);
    // Sans relevé clos à la date, pas de solde de relevé, donc pas d'équilibre affirmé.
    const early = await svcA.reconciliationReport(bank.id, "2025-03-01");
    expect(early.statementBalance).toBeNull();
    expect(early.difference).toBeNull();
    expect(early.balanced).toBe(false);
  });

  it("enchaîne les relevés et reste équilibré après un nouvel import rapproché sur tout le compte", async () => {
    const r = await svcA.importStatement(bank.id, { rows: [{ date: "2025-04-02", label: "VIR RECU X", amount: "1000" }] });
    expect(r.statement.openingBalance!.toString()).toBe("1200700.0000");
    expect(r.statement.closingBalance!.toString()).toBe("1201700.0000");
    await ledgerA.post(actorA, {
      journalCode: "BQ",
      date: "2025-04-02",
      label: "Vir reçu X",
      source: "BANK",
      lines: [
        { accountNumber: "521", debit: "1000" },
        { accountNumber: "758", credit: "1000" },
      ],
    });
    expect((await svcA.autoMatchAccount(bank.id)).matched).toBe(1);
    const report = await svcA.reconciliationReport(bank.id, "2025-04-30");
    expect(report.statementId).toBe(r.statement.id);
    expect(report.bookBalance).toBe("1201700.0000");
    expect(report.statementBalance).toBe("1201700.0000");
    expect(report.unclearedLines.map((l) => l.amount).sort()).toEqual(["-900.0000", "900.0000"]);
    expect(report.difference).toBe("0.0000");
    expect(report.balanced).toBe(true);
  });
});

async function findEntryByLabel(label: string): Promise<string> {
  const rows = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT id FROM journal_entry WHERE tenant_id = ${tenantA} AND label = ${label} AND status = 'VALIDATED'`);
  return rows[0]!.id as string;
}

run("Trésorerie — caisse", () => {
  it("enregistre un comptage, comptabilise l'écart en 658 / 758, signale caisse négative et anomalie", async () => {
    await ledgerA.post(actorA, {
      journalCode: "CA",
      date: "2025-03-01",
      label: "Apport caisse",
      source: "MANUAL",
      lines: [
        { accountNumber: "571", debit: "100000" },
        { accountNumber: "101", credit: "100000" },
      ],
    });
    const svc = service(tenantA, { cashAnomalyThreshold: "1000" });
    const small = await svc.recordCashCount(cash.id, { date: "2025-03-15", countedAmount: "99500", note: "petit écart", postDifference: true });
    expect(small.count.bookAmount.toString()).toBe("100000.0000");
    expect(small.count.difference.toString()).toBe("-500.0000");
    expect(small.anomaly).toBe(false);
    expect(small.negativeCash).toBe(false);
    expect(small.entry!.lines.map((l) => [l.accountNumber, l.debit.toString(), l.credit.toString()])).toEqual([
      ["658", "500.0000", "0.0000"],
      ["571", "0.0000", "500.0000"],
    ]);
    expect(small.count.entryId).toBe(small.entry!.id);

    const surplus = await svc.recordCashCount(cash.id, { date: "2025-03-20", countedAmount: "102000", postDifference: true });
    expect(surplus.count.bookAmount.toString()).toBe("99500.0000");
    expect(surplus.anomaly).toBe(true);
    expect(surplus.entry!.lines.map((l) => l.accountNumber)).toEqual(["571", "758"]);
    expect((await svc.bookBalance(cash.id, "2025-03-31")).toString()).toBe("102000.0000");

    const negative = await svc.recordCashCount(cash.id, { date: "2025-03-25", countedAmount: "-10" });
    expect(negative.negativeCash).toBe(true);
    expect(negative.entry).toBeNull();
    expect(negative.warnings.some((w) => /négative/.test(w))).toBe(true);

    const report = await svc.reconciliationReport(cash.id, "2025-03-31");
    expect(report.cashCountAnomalies.map((a) => a.difference)).toEqual(["-102010.0000", "2500.0000"]);
    expect((await svc.listCashCounts(cash.id)).map((c) => c.countedOn)).toEqual(["2025-03-25", "2025-03-20", "2025-03-15"]);
    await expect(svc.recordCashCount(bank.id, { date: "2025-03-25", countedAmount: "1" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const audits = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT action FROM audit_log WHERE tenant_id = ${tenantA} AND action LIKE 'treasury.cash.%' ORDER BY id`);
    expect(audits.map((a) => a.action)).toContain("treasury.cash.anomaly");
    expect(audits.map((a) => a.action)).toContain("treasury.cash.negative");
  });
});

run("Trésorerie — périodes closes et prévision", () => {
  it("importe une ligne datée dans une période close, mais refuse d'y créer une écriture", async () => {
    await withTenant(db, { tenantId: tenantA }, (tx) => tx`UPDATE period SET status = 'CLOSED' WHERE tenant_id = ${tenantA} AND start_date = '2025-02-01'`);
    const r = await svcA.importStatement(bank.id, { rows: [{ date: "2025-02-10", label: "FRAIS FEVRIER", amount: "-2000" }] });
    expect(r.rowsInClosedPeriods).toBe(1);
    const tx = (await svcA.listTransactions(r.statement.id))[0]!;
    await expect(svcA.createEntryFromTransaction(tx.id, { accountNumber: "631" })).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
    expect((await svcA.getTransaction(tx.id)).status).toBe("UNMATCHED");
  });

  it("prévision 13 semaines à partir des soldes comptables", async () => {
    const f = await svcA.forecast("2025-04-30", { receivables: [{ dueDate: "2025-05-10", amount: "500000" }], recurring: [{ label: "Loyer", amount: "400000", direction: "OUT", frequency: "MONTHLY", dayOfMonth: 1 }] });
    expect(f.openingByAccount.map((b) => [b.label, b.balance])).toEqual([
      ["SGBCI courant", "1201700.0000"],
      ["Caisse siège", "102000.0000"],
      ["Orange Money", "0.0000"],
    ]);
    expect(f.weeks[0]!.opening).toBe("1303700.0000");
    expect(f.weeks).toHaveLength(13);
    const only = await svcA.forecast("2025-04-30", { accountIds: [cash.id], weeks: 2 });
    expect(only.weeks[0]!.opening).toBe("102000.0000");
  });
});

run("Trésorerie — isolation entre dossiers (RLS)", () => {
  it("le dossier B ne voit ni les comptes, ni les relevés, ni les lignes du dossier A", async () => {
    expect(await svcB.listAccounts()).toEqual([]);
    await expect(svcB.getAccount(bank.id)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(svcB.getStatement(statementId)).rejects.toMatchObject({ code: "STATEMENT_NOT_FOUND" });
    await expect(svcB.autoMatch(statementId)).rejects.toMatchObject({ code: "STATEMENT_NOT_FOUND" });
    await expect(svcB.reconciliationReport(bank.id, "2025-03-31")).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    const seen = await withTenant(appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM bank_transaction`);
    expect(seen[0]!.n).toBe(0);
    const txA = (await svcA.listTransactions(statementId))[0]!;
    await expect(svcB.ignore(txA.id)).rejects.toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });

  it("le dossier B ne peut pas écrire dans le dossier A, même en forgeant tenant_id", async () => {
    await expect(
      withTenant(appDb, { tenantId: tenantB }, (tx) => tx`INSERT INTO treasury_account (tenant_id, kind, label, account_number, currency) VALUES (${tenantA}, 'BANK', 'Intrus', '522', 'XOF')`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(appDb, { tenantId: tenantB }, (tx) => tx`UPDATE bank_transaction SET status = 'IGNORED' WHERE tenant_id = ${tenantA}`),
    ).resolves.toHaveLength(0);
    // B a son propre compte 521, sans interférence avec celui de A.
    const b = await svcB.createAccount({ kind: "BANK", label: "Banque B", accountNumber: "521", currency: "XOF" });
    expect((await svcB.listAccounts()).map((a) => a.id)).toEqual([b.id]);
    expect((await svcA.listAccounts()).map((a) => a.id)).not.toContain(b.id);
  });
});
