import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@arcompt/db/testing";
import { withTenant } from "@arcompt/db";
import type { Db } from "@arcompt/db";
import { PostgresQueue } from "./postgres-queue.js";
import { createApp } from "./app.js";
import { Ledger, MemoryStore } from "@arcompt/ledger";

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
    queue = new PostgresQueue(app, 1, admin);
  });
  afterAll(async () => { await queue?.close(); await fixture?.drop(); });

  it("executes extraction and imports, retries errors, and deduplicates across instances", async () => {
    if (!fixture) return;
    const seen: string[] = [];
    queue.process("document.extract", async (p, ctx) => {
      seen.push(`extract:${p.documentId}:${ctx.attempt}`);
      if (ctx.attempt === 1) throw new Error("temporary AI outage");
    });
    const second = new PostgresQueue(app, 1000, admin);
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

  it("keeps tenant writes on the app pool and claims on the dedicated queue pool", async () => {
    if (!fixture) return;
    const split = new PostgresQueue(app, 1, admin);
    split.process("document.extract", async () => {});
    const { id } = await split.enqueue("document.extract", { tenantId, userId: tenantId, documentId: tenantId });
    expect((await app`SELECT id FROM background_job WHERE id = ${id}`)).toHaveLength(0);
    await split.tick();
    expect((await admin`SELECT status FROM background_job WHERE id = ${id}`)[0]?.status).toBe("DONE");
    const [privileges] = await admin`
      SELECT has_function_privilege('arcompt_app', 'background_job_claim(text[])', 'EXECUTE') AS app_claim,
             has_function_privilege('arcompt_queue', 'background_job_claim(text[])', 'EXECUTE') AS queue_claim`;
    expect(privileges).toMatchObject({ app_claim: false, queue_claim: true });
    await split.close();
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

  it("retries only failed internal work within the active tenant", async () => {
    if (!fixture) return;
    const { id } = await queue.enqueue("document.extract", { tenantId, userId: tenantId, documentId: tenantId });
    await admin`UPDATE background_job SET status = 'FAILED', attempts = 3, last_error = 'temporary failure' WHERE id = ${id}`;
    const retry = (tenant: string) => withTenant(app, { tenantId: tenant }, async (tx) =>
      (await tx`SELECT background_job_retry_internal(${id}) AS ok`)[0]?.ok);
    expect(await retry(otherTenantId)).toBe(false);
    expect(await retry(tenantId)).toBe(true);
    expect(await retry(tenantId)).toBe(false);
    expect((await admin`SELECT status, attempts, last_error FROM background_job WHERE id = ${id}`)[0])
      .toMatchObject({ status: "PENDING", attempts: 0, last_error: null });
  });

  it("records a confirmed delivery without sending again and permits one new send only after confirmed non-delivery", async () => {
    if (!fixture) return;
    const makeFailed = async () => {
      const { id } = await queue.enqueue("dunning.send", { tenantId, userId: tenantId, invoiceId: tenantId, channel: "EMAIL" });
      await admin`UPDATE background_job SET status = 'FAILED', attempts = 1 WHERE id = ${id}`;
      return id;
    };
    const review = (id: string, tenant: string, outcome: string, actor = tenantId, reviewer = actor) =>
      withTenant(app, { tenantId: tenant, userId: actor }, async (tx) =>
        (await tx`SELECT background_job_review_reminder(${id}, ${reviewer}, ${outcome}) AS reviewed`)[0]?.reviewed);
    const delivered = await makeFailed();
    expect(await review(delivered, otherTenantId, "DELIVERED")).toBeNull();
    expect(await review(delivered, tenantId, "NOT_DELIVERED", tenantId, otherTenantId)).toBeNull();
    expect(await review(delivered, tenantId, "DELIVERED")).toBe(delivered);
    expect(await review(delivered, tenantId, "NOT_DELIVERED")).toBeNull();
    expect((await admin`SELECT replacement_job_id FROM background_job_review WHERE source_job_id = ${delivered}`)[0]?.replacement_job_id).toBeNull();

    const unsent = await makeFailed();
    const outcomes = await Promise.all([
      review(unsent, tenantId, "NOT_DELIVERED"),
      review(unsent, tenantId, "NOT_DELIVERED"),
    ]);
    expect(outcomes.filter(Boolean)).toEqual([unsent]);
    const [record] = await admin`SELECT r.outcome, j.status, j.name, j.max_attempts, j.payload
      FROM background_job_review r JOIN background_job j ON j.id = r.replacement_job_id WHERE r.source_job_id = ${unsent}`;
    expect(record).toMatchObject({ outcome: "NOT_DELIVERED", status: "PENDING", name: "dunning.send", max_attempts: 1 });
    expect(record?.payload).toMatchObject({ invoiceId: tenantId, channel: "EMAIL" });
    expect((await admin`SELECT status FROM background_job WHERE id = ${unsent}`)[0]?.status).toBe("FAILED");
  });

  it("exposes only tenant jobs and refuses reminder resends until external delivery is confirmed", async () => {
    if (!fixture) return;
    const api = createApp({ quiet: true, auth: { mode: "dev" }, db: app,
      jobs: queue, jobStatusSupported: true,
      ledgerFor: () => new Ledger(new MemoryStore(), { baseCurrency: "XOF" }) });
    const headers = (tenant: string) => ({ "content-type": "application/json", "x-user-id": tenantId, "x-tenant-id": tenant });
    const count = async (tenant: string) => {
      const response = await api.request("/v1/jobs/review-count", { headers: headers(tenant) });
      expect(response.status).toBe(200);
      return (await response.json() as { count: number }).count;
    };
    const initial = await count(tenantId);
    const { id } = await queue.enqueue("dunning.send", { tenantId, userId: tenantId, invoiceId: tenantId, channel: "EMAIL" });
    expect(await count(tenantId)).toBe(initial);
    await admin`UPDATE background_job SET status = 'FAILED', attempts = 1 WHERE id = ${id}`;
    const before = await count(tenantId);
    expect(before).toBe(initial + 1);
    expect(await count(otherTenantId)).toBe(0);
    const list = await api.request("/v1/jobs?status=FAILED", { headers: headers(tenantId) });
    expect(list.status).toBe(200);
    const { jobs } = await list.json() as { jobs: { id: string; resource_id: string; payload?: unknown }[]; hasMore: boolean };
    expect(jobs.find((j) => j.id === id)).toMatchObject({ resource_id: tenantId });
    expect(jobs.find((j) => j.id === id)?.payload).toBeUndefined();
    const otherResponse = await api.request("/v1/jobs?status=FAILED", { headers: headers(otherTenantId) });
    const { jobs: otherJobs } = await otherResponse.json() as { jobs: { id: string }[] };
    expect(otherJobs).not.toContainEqual(expect.objectContaining({ id }));
    const post = (path: string, body: object, tenant = tenantId) =>
      api.request(path, { method: "POST", headers: headers(tenant), body: JSON.stringify(body) });
    expect((await post(`/v1/jobs/${id}/retry`, {})).status).toBe(409);
    expect((await post(`/v1/jobs/${id}/review`, { outcome: "NOT_DELIVERED", confirmed: false })).status).toBe(400);
    expect(await count(tenantId)).toBe(before);
    expect((await post(`/v1/jobs/${id}/review`, { outcome: "NOT_DELIVERED", confirmed: true }, otherTenantId)).status).toBe(409);
    expect((await post(`/v1/sales/${tenantId}/dunning/schedule`, { channel: "EMAIL", delayMs: 0, requestId: tenantId })).status).toBe(409);
    expect((await post(`/v1/sales/${tenantId}/dunning`, { channel: "EMAIL", level: 1 })).status).toBe(409);
    expect((await post(`/v1/jobs/${id}/review`, { outcome: "DELIVERED", confirmed: true })).status).toBe(200);
    expect(await count(tenantId)).toBe(before - 1);
    expect((await post(`/v1/jobs/${id}/review`, { outcome: "NOT_DELIVERED", confirmed: true })).status).toBe(409);
  });

  it("pages past 100 failed jobs to review an older reminder without exposing another tenant", async () => {
    if (!fixture) return;
    const api = createApp({ quiet: true, auth: { mode: "dev" }, db: app,
      jobs: queue, jobStatusSupported: true,
      ledgerFor: () => new Ledger(new MemoryStore(), { baseCurrency: "XOF" }) });
    const headers = (tenant: string) => ({ "content-type": "application/json", "x-user-id": tenantId, "x-tenant-id": tenant });
    const inserted = await admin`
      INSERT INTO background_job (tenant_id, name, payload, status, attempts, created_at)
      SELECT ${tenantId}, 'dunning.send',
        jsonb_build_object('tenantId', ${tenantId}::text, 'userId', ${tenantId}::text, 'invoiceId', ${tenantId}::text, 'channel', 'EMAIL'),
        'FAILED', 1, now() - interval '1 day' - n * interval '1 minute'
      FROM generate_series(1, 105) n
      RETURNING id, created_at`;
    const oldest = inserted.reduce((a, b) => a.created_at < b.created_at ? a : b);
    const [foreign] = await admin`
      INSERT INTO background_job (tenant_id, name, payload, status, attempts, created_at)
      VALUES (${otherTenantId}, 'dunning.send', '{}'::jsonb, 'FAILED', 1, now() + interval '1 day')
      RETURNING id`;
    const getPage = async (offset: string, tenant = tenantId) =>
      api.request(`/v1/jobs?status=FAILED&offset=${offset}`, { headers: headers(tenant) });
    expect((await getPage("-1")).status).toBe(400);
    expect((await getPage("1.5")).status).toBe(400);
    const firstResponse = await getPage("0");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { jobs: { id: string; name: string; review_outcome: string | null }[]; hasMore: boolean };
    expect(first.jobs).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.jobs.every((j) => j.name === "dunning.send" && j.review_outcome === null)).toBe(true);
    expect(first.jobs.some((j) => j.id === oldest.id || j.id === foreign?.id)).toBe(false);
    const secondResponse = await getPage("100");
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as typeof first;
    expect(second.jobs.some((j) => j.id === oldest.id)).toBe(true);
    expect(second.jobs.some((j) => j.id === foreign?.id)).toBe(false);
    expect((await getPage("100", otherTenantId).then((r) => r.json()) as typeof first).jobs).toEqual([]);
    const reviewPath = `/v1/jobs/${oldest.id}/review`;
    const review = (confirmed: boolean, tenant = tenantId) =>
      api.request(reviewPath, { method: "POST", headers: headers(tenant), body: JSON.stringify({ outcome: "DELIVERED", confirmed }) });
    expect((await review(false)).status).toBe(400);
    expect((await review(true, otherTenantId)).status).toBe(409);
    expect((await review(true)).status).toBe(200);
    expect((await review(true)).status).toBe(409);
    const [record] = await admin`SELECT outcome, reviewer_id FROM background_job_review WHERE source_job_id = ${oldest.id}`;
    expect(record).toMatchObject({ outcome: "DELIVERED", reviewer_id: tenantId });
    const after = await getPage("0").then((r) => r.json()) as typeof first;
    expect(after.jobs.some((j) => j.id === oldest.id)).toBe(false);
  });
});