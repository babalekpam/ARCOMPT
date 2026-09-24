import { createDb } from "@arcompt/db";
import { createQueueFromEnv } from "@arcompt/jobs";
import { createProviderFromEnv } from "@arcompt/whatsapp";
import { registerJobHandlers } from "./job-handlers.js";
import { initTelemetry, log } from "./telemetry.js";

if (!process.env.REDIS_URL) throw new Error("Worker séparé impossible sans REDIS_URL : démarrer l'API qui consomme la file PostgreSQL");
await initTelemetry();
const db = createDb();
const queue = createQueueFromEnv();
registerJobHandlers(queue, db);
queue.process("whatsapp.reply", async ({ to, text }) => {
  const provider = createProviderFromEnv();
  if (!provider) throw new Error("Canal WhatsApp non configuré : le message n'a pas été envoyé.");
  await provider.sendText(to, text);
});
queue.process("render.pdf", async () => {
  throw new Error("Rendu PDF en tâche de fond non implémenté : utiliser la route de rendu synchrone");
});
log("info", "worker.started", { redis: true });
const shutdown = async () => {
  await queue.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());