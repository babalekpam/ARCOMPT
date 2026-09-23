// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { BullMqQueue } from "./bullmq.js";
import { InProcessQueue } from "./in-process.js";
import type { JobQueue } from "./queue.js";

export * from "./queue.js";
export * from "./in-process.js";
export * from "./bullmq.js";

/** BullMQ si REDIS_URL est défini, sinon exécution en processus. */
export function createQueueFromEnv(env: NodeJS.ProcessEnv = process.env): JobQueue {
  if (env.REDIS_URL) return new BullMqQueue({ redisUrl: env.REDIS_URL, ...(env.JOBS_PREFIX ? { prefix: env.JOBS_PREFIX } : {}) });
  return new InProcessQueue();
}
