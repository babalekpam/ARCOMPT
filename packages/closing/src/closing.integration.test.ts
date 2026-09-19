import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { ClosingService } from "./service.js";
// `@arcompt/db` n'expose pas encore « ./testing » dans son export map : import relatif.
import { createTestDatabase } from "../../db/src/testing.js";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let accountantId: string;
let reviewerId: string;
let ownerId: string;
let tenantA: string;
let tenantB: string;
let accountant: ClosingService; // ACCOUNTANT sur A
let reviewer: ClosingService; // REVIEWER sur A
let owner: ClosingService; // OWNER sur A
let serviceB: ClosingService;
let ledgerA: Ledger;
let march: string;
let december: string;

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Test') RETURNING id`;
  const orgId = org!.id as string;
  const users = await db`
    INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'acc@t.t', 'Comptable'), (${orgId}, 'rev@t.t', 'Expert'), (${orgId}, 'own@t.t', 'Dirigeant') RETURNING id`;
  accountantId = users[0]!.id as string;
  reviewerId = users[1]!.id as string;
  ownerId = users[2]!.id as string;
  const fy = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear: fy })).companyId;
  await withTenant(db, { tenantId: tenantA, organizationId: orgId }, (tx) =>
    tx`INSERT INTO company_member (company_id, user_id, role) VALUES (${tenantA}, ${accountantId}, 'ACCOUNTANT'), (${tenantA}, ${reviewerId}, 'REVIEWER'), (${tenantA}, ${ownerId}, 'OWNER')`,
  );
  const sql = env.appDb as unknown as Sql;
  const ledgerFor = (userId: string) => new Ledger(new PostgresStore(sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  ledgerA = ledgerFor(accountantId);
  const make = (tenantId: string, userId: string, roles: string[]) => new ClosingService({ db: sql, ledger: ledgerFor(userId), ctx: { tenantId, userId, organizationId: orgId, roles }, currency: "XOF" });
  accountant = make(tenantA, accountantId, ["ACCOUNTANT"]);
  reviewer = make(tenantA, reviewerId, ["REVIEWER"]);
  owner = make(tenantA, ownerId, ["OWNER"]);
  serviceB = make(tenantB, accountantId, ["ACCOUNTANT"]);

  const [client] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Client', '411') RETURNING id`);
  await ledgerA.post(
    { userId: accountantId, tenantId: tenantA },
    {
      journalCode: "VT",
      date: "2025-03-15",
      label: "Facture",
      source: "INVOICE",
      lines: [
        { accountNumber: "411", debit: "1180000", partnerId: client!.id as string },
        { accountNumber: "706", credit: "1000000" },
        { accountNumber: "443", credit: "180000" },
      ],
    },
  );
  const periods = await accountant.periods("2025");
  march = periods.find((p) => p.startDate === "2025-03-01")!.id;
  december = periods.find((p) => p.isLast)!.id;
});

afterAll(async () => {
  await env?.drop();
});

async function tickAll(service: ClosingService, input: { fiscalYearCode: string; periodId?: string }) {
  for (const item of await service.generateChecklist(input)) {
    if (item.blocking) await service.tick(item.id, { status: "DONE", evidence: { note: "vérifié" } });
  }
}

run("Clôture — périodes", () => {
  it("refuse la clôture tant que des items bloquants sont TODO, puis clôture", async () => {
    const items = await accountant.generateChecklist({ fiscalYearCode: "2025", periodId: march });
    expect(items).toHaveLength(6);
    expect(await accountant.generateChecklist({ fiscalYearCode: "2025", periodId: march })).toHaveLength(6); // idempotent
    await expect(accountant.closePeriod(march)).rejects.toMatchObject({ code: "CHECKLIST_INCOMPLETE" });

    const vat = items.find((i) => i.key === "vat_declared")!;
    const ticked = await accountant.tick(vat.id, { status: "NA", evidence: { reason: "franchise" } });
    expect(ticked.status).toBe("NA");
    expect(ticked.doneBy).toBe(accountantId);
    for (const i of items.filter((x) => x.blocking && x.key !== "vat_declared")) await accountant.tick(i.id, { status: "DONE" });

    const closed = await accountant.closePeriod(march);
    expect(closed.status).toBe("CLOSED");
    await expect(accountant.closePeriod(march)).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Le grand livre refuse désormais toute écriture en mars.
    await expect(
      ledgerA.post({ userId: accountantId, tenantId: tenantA }, { journalCode: "OD", date: "2025-03-20", label: "x", source: "MANUAL", lines: [{ accountNumber: "521", debit: "1" }, { accountNumber: "571", credit: "1" }] }),
    ).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
  });

  it("déverrouille seulement avec commentaire, approbateur distinct REVIEWER/OWNER, et trace period.unlock", async () => {
    await expect(accountant.unlockPeriod(march, { comment: "Facture oubliée en mars", approverId: reviewerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(owner.unlockPeriod(march, { comment: "", approverId: reviewerId })).rejects.toMatchObject({ code: "COMMENT_REQUIRED" });
    await expect(owner.unlockPeriod(march, { comment: "Facture oubliée en mars", approverId: ownerId })).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES" });
    await expect(owner.unlockPeriod(march, { comment: "Facture oubliée en mars", approverId: accountantId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reopened = await owner.unlockPeriod(march, { comment: "Facture oubliée en mars", approverId: reviewerId });
    expect(reopened.status).toBe("OPEN");
    const audit = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT user_id, after FROM audit_log WHERE tenant_id = ${tenantA} AND action = 'period.unlock'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.user_id).toBe(ownerId);
    expect(audit[0]!.after).toMatchObject({ approverId: reviewerId, comment: "Facture oubliée en mars" });
    // Re-clôture : la liste est toujours cochée.
    expect((await accountant.closePeriod(march)).status).toBe("CLOSED");
  });

  it("clôture annuelle : autres périodes closes, liste annuelle et contrôles des états", async () => {
    await tickAll(accountant, { fiscalYearCode: "2025", periodId: december });
    await expect(accountant.closePeriod(december)).rejects.toMatchObject({ code: "CHECKLIST_INCOMPLETE" }); // liste annuelle
    await tickAll(accountant, { fiscalYearCode: "2025" });
    await expect(accountant.closePeriod(december)).rejects.toMatchObject({ code: "PERIODS_OPEN" });
    await withTenant(db, { tenantId: tenantA }, (tx) => tx`UPDATE period SET status = 'CLOSED' WHERE tenant_id = ${tenantA} AND id <> ${december} AND status = 'OPEN'`);
    expect(await accountant.failedBlockingControls("2025")).toEqual([]);
    const closed = await accountant.closePeriod(december);
    expect(closed.status).toBe("CLOSED");
    const [fy] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT status FROM fiscal_year WHERE tenant_id = ${tenantA} AND code = '2025'`);
    expect(fy!.status).toBe("CLOSED");
  });
});

run("Clôture — workflow de l'exercice", () => {
  it("suit le graphe avec rôles, contrôles, séparation des tâches et accusé de dépôt", async () => {
    expect((await accountant.getWorkflow("2025")).state).toBe("TENUE");
    await expect(accountant.transition("2025", "ETATS")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await accountant.transition("2025", "REVISION", { comment: "Clôture demandée" })).state).toBe("REVISION");
    // L'expert produit les états : il ne pourra pas les viser lui-même.
    expect((await reviewer.transition("2025", "ETATS")).state).toBe("ETATS");
    expect((await accountant.transition("2025", "VISA")).reviewerId).toBe(accountantId);
    await expect(reviewer.transition("2025", "DEPOT")).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES" });
    await expect(accountant.transition("2025", "DEPOT")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await reviewer.transition("2025", "REVISION", { comment: "Rejet : note 7 incomplète" })).approverId).toBeNull();
    expect((await accountant.transition("2025", "ETATS")).state).toBe("ETATS");
    expect((await accountant.transition("2025", "VISA")).state).toBe("VISA");
    const visa = await reviewer.transition("2025", "DEPOT", { comment: "Visé" });
    expect(visa.state).toBe("DEPOT");
    expect(visa.approverId).toBe(reviewerId);
    await expect(accountant.transition("2025", "VERROUILLE")).rejects.toMatchObject({ code: "RECEIPT_REQUIRED" });

    const [doc] = await withTenant(db, { tenantId: tenantA }, (tx) =>
      tx`INSERT INTO document (tenant_id, storage_key, sha256, mime_type, size_bytes, uploaded_by) VALUES (${tenantA}, 'receipts/dsf-2025.pdf', 'abc', 'application/pdf', 10, ${accountantId}) RETURNING id`,
    );
    const locked = await accountant.transition("2025", "VERROUILLE", { filingReceiptDocumentId: doc!.id as string, comment: "Accusé DGI joint" });
    expect(locked.state).toBe("VERROUILLE");
    expect(locked.filingReceiptDocumentId).toBe(doc!.id);
    expect(locked.history.map((h) => h.to)).toEqual(["REVISION", "ETATS", "VISA", "REVISION", "ETATS", "VISA", "DEPOT", "VERROUILLE"]);
    const periods = await accountant.periods("2025");
    expect(periods.every((p) => p.status === "LOCKED")).toBe(true);
    const [fy] = await withTenant(db, { tenantId: tenantA }, (tx) => tx`SELECT status FROM fiscal_year WHERE tenant_id = ${tenantA} AND code = '2025'`);
    expect(fy!.status).toBe("LOCKED");
    await expect(owner.unlockPeriod(march, { comment: "Tentative après verrouillage", approverId: reviewerId })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(accountant.transition("2025", "TENUE")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("isole les dossiers (RLS)", async () => {
    expect((await serviceB.getWorkflow("2025")).state).toBe("TENUE");
    expect(await serviceB.listChecklist({ fiscalYearCode: "2025" })).toEqual([]);
    await expect(serviceB.closePeriod(march)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = await withTenant(env!.appDb, { tenantId: tenantB }, (tx) => tx`SELECT count(*)::int AS n FROM closing_checklist`);
    expect(rows[0]!.n).toBe(0);
  });
});
