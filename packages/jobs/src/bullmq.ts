import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { DEFAULT_ATTEMPTS, DEFAULT_BACKOFF_MS, type EnqueueOptions, type JobHandler, type JobName, type JobPayloads, type JobQueue } from "./queue.js";

export interface BullMqQueueOptions {
  redisUrl: string;
  /** Préfixe des files (un par environnement). */
  prefix?: string;
  concurrency?: number;
}

/**
 * BullMQ + Redis : une file par nom de tâche, un worker par gestionnaire
 * enregistré. Les tentatives et le délai exponentiel sont délégués à BullMQ.
 */
export class BullMqQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queues = new Map<JobName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly prefix: string;
  private readonly concurrency: number;

  constructor(opts: BullMqQueueOptions) {
    this.connection = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.prefix = opts.prefix ?? "arcompt";
    this.concurrency = opts.concurrency ?? 2;
  }

  private queue(name: JobName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, prefix: this.prefix });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts: EnqueueOptions = {}): Promise<{ id: string }> {
    const job = await this.queue(name).add(name, payload, {
      attempts: opts.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: "exponential", delay: opts.backoffMs ?? DEFAULT_BACKOFF_MS },
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    return { id: String(job.id) };
  }

  process<N extends JobName>(name: N, handler: JobHandler<N>): void {
    const worker = new Worker(
      name,
      async (job: Job) => {
        await handler(job.data as JobPayloads[N], { id: String(job.id), name, attempt: job.attemptsMade + 1 });
      },
      { connection: this.connection, prefix: this.prefix, concurrency: this.concurrency },
    );
    this.workers.push(worker);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    await this.connection.quit();
  }
}
