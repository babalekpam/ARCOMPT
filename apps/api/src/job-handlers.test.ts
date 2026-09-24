import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedCompany, withTenant, type Db } from "@arcompt/db";
import { createTestDatabase } from "@arcompt/db/testing";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { TreasuryService } from "@arcompt/treasury";
import { PostgresQueue } from "./postgres-queue.js";
import { registerJobHandlers } from "./job-handlers.js";

vi.mock("@arcompt/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@arcompt/documents")>();
  return { ...actual, createDocumentsServiceFromEnv: vi.fn() };
});
import { createDocumentsServiceFromEnv } from "@arcompt/documents";

describe("actual background handlers", () => {
  let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: Db;
  let tenantId: string;
  let orgId: string;
  let userId: string;
  let bankId: string;
  let queue: PostgresQueue;

  beforeAll(async () => {
    fixture = await createTestDatabase();
    if (!fixture) return;
    db = fixture.appDb;
    const [org] = await fixture.db`INSERT INTO organization (name) VALUES ('Jobs handlers') RETURNING id`;
    orgId = String(org!.id);
    const [user] = await fixture.db`INSERT INTO app_user (organization_id, email, display_name)
      VALUES (${orgId}, 'jobs@example.test', 'Job Tester') RETURNING id`;
    userId = String(user!.id);
    tenantId = (await seedCompany(fixture.db, {
      organizationId: orgId, name: "Test", countryCode: "CI", currency: "XOF",
      packVersion: "ci@2025.1", fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
    })).companyId;
    const treasury = new TreasuryService({
      db, ctx: { tenantId, userId, organizationId: orgId },
      ledger: new Ledger(new PostgresStore(db, { userId, organizationId: orgId }), { baseCurrency: "XOF" }),
    });
    bankId = (await treasury.createAccount({ kind: "BANK", label: "Test bank", accountNumber: "521", currency: "XOF" })).id;
    queue = new PostgresQueue(db);
    registerJobHandlers(queue, db);
  });
  afterAll(async () => { await queue?.close(); await fixture?.drop(); });

  it("resumes extraction at proposal without calling AI twice", async () => {
    if (!fixture) return;
    const extract = vi.fn().mockResolvedValue({ needsOcr: false });
    const propose = vi.fn().mockResolvedValue({});
    vi.mocked(createDocumentsServiceFromEnv).mockReturnValue({
      getDocument: vi.fn().mockResolvedValue({ status: "EXTRACTED" }), extract, propose,
    } as never);
    const { id } = await queue.enqueue("document.extract", { tenantId, userId, documentId: tenantId, organizationId: orgId });
    await queue.tick();
    expect(extract).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledWith(tenantId);
    expect((await fixture.db`SELECT status FROM background_job WHERE id = ${id}`)[0]?.status).toBe("DONE");
  });

  it("imports CSV once even when acknowledgment is lost and the job runs again", async () => {
    if (!fixture) return;
    const csv = "Date;Libellé;Débit;Crédit\n05/03/2025;Virement;;1000";
    const { id } = await queue.enqueue("import.statement", { tenantId, userId, accountId: bankId, organizationId: orgId, csv });
    await queue.tick();
    expect((await withTenant(db, { tenantId }, (tx) => tx`SELECT id FROM bank_statement WHERE tenant_id = ${tenantId}`)).length).toBe(1);
    await fixture.db`UPDATE background_job SET status = 'RUNNING', attempts = 1,
      lock_token = gen_random_uuid(), locked_until = now() - interval '1 minute' WHERE id = ${id}`;
    await queue.tick();
    expect((await withTenant(db, { tenantId }, (tx) => tx`SELECT id FROM bank_statement WHERE tenant_id = ${tenantId}`)).length).toBe(1);
    expect((await fixture.db`SELECT status FROM background_job WHERE id = ${id}`)[0]?.status).toBe("DONE");
  });

  it("runs a reminder handler but records an invalid invoice as failed without retrying", async () => {
    if (!fixture) return;
    const { id } = await queue.enqueue("dunning.send", {
      tenantId, userId, invoiceId: tenantId, channel: "EMAIL",
    });
    await queue.tick();
    expect((await fixture.db`SELECT status, attempts, last_error FROM background_job WHERE id = ${id}`)[0])
      .toMatchObject({ status: "FAILED", attempts: 1 });
  });
});