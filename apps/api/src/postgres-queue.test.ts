import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@arcompt/db/testing";
import type { Db } from "@arcompt/db";
import { PostgresQueue } from "./postgres-queue.js";

describe("Replit durable background queue", () => {
  let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
  let admin: Db;
  let app: Db;
  let tenantId: string;
  let otherTenantId: string;
  let queue: PostgresQueue;

  beforeAll(async () => {
    fixture = await createTestDatabase();
    if (!fixture) return;
    admin = fixture.db;
    app = fixture.appDb;
    const [org] = await admin`INSERT INTO organization (name, kind, plan) VALUES ('Jobs', 'FIRM', 'TRIAL') RETURNING id`;
    const companies = await admin`
      INSERT INTO company (organization_id, name, country_code, currency, accounting_system, pack_version)
      VALUES (${org!.id}, 'A', 'CI', 'XOF', 'NORMAL', 'ci@2025.1'),
             (${org!.id}, 'B', 'CI', 'XOF', 'NORMAL', 'ci@2025.1') RETURNING id`;
    tenantId = String(companies[0]!.id);
    otherTenantId = String(companies[1]!.id);
    queue = new PostgresQueue(app, 1);
  });
  afterAll(async () => { await queue?.close(); await fixture?.drop(); });

  it("executes extraction and imports, retries errors, and deduplicates across instances", async () => {
    if (!fixture) return;
    const seen: string[] = [];
    queue.process("document.extract", async (p, ctx) => {
      seen.push(`extract:${p.documentId}:${ctx.attempt}`);
      if (ctx.attempt === 1) throw new Error("temporary AI outage");
    });
    const second = new PostgresQueue(app);
    second.process("import.statement", async (p) => { seen.push(`import:${p.accountId}`); });
    const payload = { tenantId, userId: tenantId, documentId: tenantId };
    const first = await queue.enqueue("document.extract", payload, { jobId: "extract-a", backoffMs: 0 });
    expect((await second.enqueue("document.extract", payload, { jobId: "extract-a" })).id).toBe(first.id);
    await second.enqueue("import.statement", { tenantId, userId: tenantId, accountId: tenantId, csv: "date;amount" });
    await queue.tick();
    await queue.tick();
    await second.tick();
    expect(seen).toEqual([`extract:${tenantId}:1`, `extract:${tenantId}:2`, `import:${tenantId}`]);
    expect((await admin`SELECT status, attempts FROM background_job WHERE id = ${first.id}`)[0]).toMatchObject({ status: "DONE", attempts: 2 });
    await second.close();
  });

  it("recovers abandoned extraction/import but never blindly resends a reminder", async () => {
    if (!fixture) return;
    const names = ["document.extract", "import.statement", "dunning.send"];
    const ids: string[] = [];
    for (const name of names) {
      const p = name === "document.extract"
        ? { tenantId, userId: tenantId, documentId: tenantId }
        : name === "import.statement"
          ? { tenantId, userId: tenantId, accountId: tenantId, csv: "x" }
          : { tenantId, userId: tenantId, invoiceId: tenantId, channel: "EMAIL" as const };
      const { id } = await queue.enqueue(name as "document.extract", p as never);
      ids.push(id);
    }
    await admin`UPDATE background_job SET status = 'RUNNING', attempts = 1,
      lock_token = gen_random_uuid(), locked_until = now() - interval '1 minute' WHERE id = ANY(${ids})`;
    const seen: string[] = [];
    queue.process("document.extract", async (_p, ctx) => { seen.push(`extract:${ctx.attempt}`); });
    queue.process("import.statement", async (_p, ctx) => { seen.push(`import:${ctx.attempt}`); });
    queue.process("dunning.send", async () => { seen.push("reminder"); });
    await queue.tick();
    await queue.tick();
    expect(seen).toEqual(["extract:2", "import:2"]);
    expect((await admin`SELECT status FROM background_job WHERE id = ${ids[2]!}`)[0]?.status).toBe("FAILED");
  });

  it("isolates dedupe keys per tenant and denies direct cross-tenant reads", async () => {
    if (!fixture) return;
    const a = await queue.enqueue("document.extract", { tenantId, userId: tenantId, documentId: tenantId }, { jobId: "same-key" });
    const b = await queue.enqueue("document.extract", { tenantId: otherTenantId, userId: otherTenantId, documentId: otherTenantId }, { jobId: "same-key" });
    expect(a.id).not.toBe(b.id);
    expect(await app`SELECT id FROM background_job`).toEqual([]);
  });
});