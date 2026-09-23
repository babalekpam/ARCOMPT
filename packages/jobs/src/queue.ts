/**
 * File de tâches. Deux adaptateurs : BullMQ + Redis (production, `REDIS_URL`)
 * et exécution en processus (développement sans Redis, tests).
 *
 * Les charges utiles sont typées par nom de tâche ; un module ajoute une
 * tâche en étendant `JobPayloads`.
 */
export interface JobPayloads {
  "document.extract": { tenantId: string; userId: string; documentId: string; organizationId?: string };
  "render.pdf": { tenantId: string; kind: string; params: Record<string, unknown> };
  "import.statement": { tenantId: string; userId: string; documentId: string };
  /**
   * Relance d'une facture échue. `userId` porte l'auteur : la ligne `dunning`
   * l'exige (`sent_by`), une relance étant toujours imputable à quelqu'un.
   * Sans `level`, le niveau suivant est déduit des relances déjà envoyées.
   */
  "dunning.send": { tenantId: string; userId: string; invoiceId: string; channel: "EMAIL" | "WHATSAPP" | "SMS"; level?: number; message?: string };
  "whatsapp.reply": { to: string; text: string };
}

export type JobName = keyof JobPayloads;
export const JOB_NAMES: JobName[] = ["document.extract", "render.pdf", "import.statement", "dunning.send", "whatsapp.reply"];

export interface EnqueueOptions {
  /** Nombre total de tentatives (défaut 3). */
  attempts?: number;
  /** Délai initial entre tentatives en ms (défaut 1000), doublé à chaque échec. */
  backoffMs?: number;
  /** Délai avant la première exécution en ms. */
  delayMs?: number;
  /** Identifiant idempotent : une même tâche n'est pas dupliquée. */
  jobId?: string;
}

export interface JobContext {
  id: string;
  name: JobName;
  attempt: number;
}

export type JobHandler<N extends JobName> = (payload: JobPayloads[N], ctx: JobContext) => Promise<void>;

export interface JobQueue {
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N], opts?: EnqueueOptions): Promise<{ id: string }>;
  process<N extends JobName>(name: N, handler: JobHandler<N>): void;
  close(): Promise<void>;
}

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 1000;
