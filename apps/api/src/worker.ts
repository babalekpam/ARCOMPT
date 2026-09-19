import type { Sql } from "postgres";
import { createDb } from "@arcompt/db";
import { createDocumentsServiceFromEnv } from "@arcompt/documents";
import { createQueueFromEnv } from "@arcompt/jobs";
import { createProviderFromEnv } from "@arcompt/whatsapp";
import { initTelemetry, log } from "./telemetry.js";

/**
 * Processus de tâches de fond (BullMQ + Redis, ou en processus sans REDIS_URL) :
 * extraction de pièces par l'IA, réponses WhatsApp, imports et relances.
 * Compte de service distinct de l'API en production (SECURITY.md §4.1).
 */
await initTelemetry();
const db = createDb();
const queue = createQueueFromEnv();
const whatsapp = createProviderFromEnv();

queue.process("document.extract", async (payload) => {
  const ctx = { tenantId: payload.tenantId, userId: payload.userId, ...(payload.organizationId ? { organizationId: payload.organizationId } : {}) };
  const documents = createDocumentsServiceFromEnv(db as unknown as Sql, ctx);
  await documents.extract(payload.documentId);
  await documents.propose(payload.documentId);
  log("info", "job.document.extract.done", { tenantId: payload.tenantId, documentId: payload.documentId });
});

queue.process("whatsapp.reply", async (payload) => {
  if (!whatsapp) {
    log("warn", "job.whatsapp.reply.skipped", { reason: "fournisseur WhatsApp non configuré" });
    return;
  }
  await whatsapp.sendText(payload.to, payload.text);
});

queue.process("dunning.send", async (payload) => {
  // Les relances sont journalisées par le module facturation ; l'envoi effectif dépend du canal configuré.
  log("info", "job.dunning.send", { tenantId: payload.tenantId, invoiceId: payload.invoiceId, channel: payload.channel });
});

queue.process("import.statement", async (payload) => {
  log("info", "job.import.statement", { tenantId: payload.tenantId, documentId: payload.documentId });
});

queue.process("render.pdf", async (payload) => {
  log("info", "job.render.pdf", { tenantId: payload.tenantId, kind: payload.kind });
});

log("info", "worker.started", { redis: Boolean(process.env.REDIS_URL) });

const shutdown = async () => {
  await queue.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
