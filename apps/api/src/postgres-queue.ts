import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { withTenant } from "@arcompt/db";
import type { EnqueueOptions, JobHandler, JobName, JobPayloads, JobQueue } from "@arcompt/jobs";
import { log } from "./telemetry.js";

type DurableName = "document.extract" | "import.statement" | "dunning.send";
type Row = { id: string; name: DurableName; payload: unknown; attempts: number; lock_token: string };

/** PostgreSQL is shared by the API and survives Replit restarts. Only tenant-scoped
 * jobs are accepted; no unscoped WhatsApp/PDF payload can bypass tenant RLS. */
export class PostgresQueue implements JobQueue {
  private readonly handlers = new Map<DurableName, JobHandler<JobName>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly db: Sql, private readonly intervalMs = 1000) {}

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts: EnqueueOptions = {}): Promise<{ id: string }> {
    if (this.closed) throw new Error("File fermée");
    if (name !== "document.extract" && name !== "import.statement" && name !== "dunning.send")
      throw new Error(`Tâche non persistante refusée : ${name}`);
    const tenantId = (payload as { tenantId?: string }).tenantId;
    if (!tenantId) throw new Error("Dossier requis pour la tâche");
    const id = randomUUID();
    const rows = await withTenant(this.db, { tenantId }, (tx) => tx`
      INSERT INTO background_job (id, tenant_id, name, payload, dedupe_key, max_attempts, backoff_ms, run_at)
      VALUES (${id}, ${tenantId}, ${name}, ${tx.json(payload as never)}, ${opts.jobId ?? null},
        ${name === "dunning.send" ? 1 : (opts.attempts ?? 3)}, ${opts.backoffMs ?? 1000}, now() + (${opts.delayMs ?? 0} * interval '1 millisecond'))
      ON CONFLICT (tenant_id, name, dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
      RETURNING id`);
    return { id: String(rows[0]!.id) };
  }

  process<N extends JobName>(name: N, handler: JobHandler<N>): void {
    if (name !== "document.extract" && name !== "import.statement" && name !== "dunning.send")
      throw new Error(`Tâche non persistante refusée : ${name}`);
    this.handlers.set(name, handler as JobHandler<JobName>);
  }

  start(): void {
    if (this.closed || this.timer) return;
    const schedule = () => {
      if (this.closed) return;
      this.timer = setTimeout(() => { this.timer = undefined; this.active = this.tick().finally(() => { this.active = undefined; schedule(); }); }, this.intervalMs);
    };
    schedule();
  }

  /** One claim per tick; database SKIP LOCKED allows multiple replicas safely. */
  async tick(): Promise<void> {
    if (this.closed || !this.handlers.size) return;
    try {
      const [expired] = await this.db`SELECT background_job_expire_reminders() AS count`;
      if (Number(expired?.count) > 0) log("error", "job.dunning.uncertain", { count: expired?.count });
      const rows = await this.db`SELECT * FROM background_job_claim(${[...this.handlers.keys()]})` as unknown as Row[];
      const job = rows[0];
      if (!job) return;
      const renew = setInterval(() => {
        void this.db`SELECT background_job_renew(${job.id}, ${job.lock_token})`.catch((e: unknown) =>
          log("error", "job.lease.renew_failed", { id: job.id, detail: String(e) }));
      }, 30_000);
      try {
        await this.handlers.get(job.name)!(job.payload as never, { id: job.id, name: job.name, attempt: job.attempts });
        const [done] = await this.db`SELECT background_job_finish(${job.id}, ${job.lock_token}, ${null}) AS acknowledged`;
        if (!done?.acknowledged) log("error", "job.lease.lost", { id: job.id });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        log("error", "job.failed", { id: job.id, name: job.name, detail });
        const [done] = await this.db`SELECT background_job_finish(${job.id}, ${job.lock_token}, ${detail}) AS acknowledged`;
        if (!done?.acknowledged) log("error", "job.lease.lost", { id: job.id });
      } finally {
        clearInterval(renew);
      }
    } catch (e) {
      log("error", "job.poll_failed", { detail: e instanceof Error ? e.message : String(e) });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
}