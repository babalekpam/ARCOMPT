// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { DEFAULT_ATTEMPTS, DEFAULT_BACKOFF_MS, type EnqueueOptions, type JobContext, type JobHandler, type JobName, type JobPayloads, type JobQueue } from "./queue.js";

export interface InProcessQueueOptions {
  /** Attente entre tentatives (injectable pour les tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Appelé quand toutes les tentatives ont échoué. */
  onFailed?: (job: JobContext & { payload: unknown; error: Error }) => void;
}

interface Pending {
  id: string;
  name: JobName;
  payload: unknown;
  opts: EnqueueOptions;
}

/**
 * Exécution en processus : la tâche part dès qu'un gestionnaire existe,
 * avec nouvelles tentatives et délai exponentiel. Sans gestionnaire, la tâche
 * attend dans une liste et démarre à l'enregistrement du gestionnaire.
 */
export class InProcessQueue implements JobQueue {
  private readonly handlers = new Map<JobName, JobHandler<JobName>>();
  private readonly waiting: Pending[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly seen = new Set<string>();
  readonly failed: Array<JobContext & { payload: unknown; error: Error }> = [];
  private readonly sleep: (ms: number) => Promise<void>;
  private closed = false;

  constructor(private readonly opts: InProcessQueueOptions = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts: EnqueueOptions = {}): Promise<{ id: string }> {
    if (this.closed) throw new Error("File fermée");
    const id = opts.jobId ?? randomUUID();
    if (opts.jobId) {
      if (this.seen.has(id)) return { id };
      this.seen.add(id);
    }
    const job: Pending = { id, name, payload, opts };
    const handler = this.handlers.get(name);
    if (handler) this.start(job, handler);
    else this.waiting.push(job);
    return { id };
  }

  process<N extends JobName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<JobName>);
    const mine = this.waiting.filter((j) => j.name === name);
    for (const j of mine) {
      this.waiting.splice(this.waiting.indexOf(j), 1);
      this.start(j, handler as JobHandler<JobName>);
    }
  }

  /** Attend la fin de toutes les tâches en cours (tests, arrêt propre). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drain();
  }

  private start(job: Pending, handler: JobHandler<JobName>): void {
    const p = this.run(job, handler).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  private async run(job: Pending, handler: JobHandler<JobName>): Promise<void> {
    const attempts = job.opts.attempts ?? DEFAULT_ATTEMPTS;
    const backoff = job.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    if (job.opts.delayMs) await this.sleep(job.opts.delayMs);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ctx: JobContext = { id: job.id, name: job.name, attempt };
      try {
        await handler(job.payload as never, ctx);
        return;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (attempt >= attempts) {
          const failed = { ...ctx, payload: job.payload, error };
          this.failed.push(failed);
          this.opts.onFailed?.(failed);
          return;
        }
        await this.sleep(backoff * 2 ** (attempt - 1));
      }
    }
  }
}
