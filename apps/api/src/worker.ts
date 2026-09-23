// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { loadPack, type CountryPack } from "@arcompt/country-packs";
import { createDb, withTenant } from "@arcompt/db";
import { createDocumentsServiceFromEnv } from "@arcompt/documents";
import { InvoicingError, InvoicingService } from "@arcompt/invoicing";
import { createQueueFromEnv } from "@arcompt/jobs";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { createProviderFromEnv } from "@arcompt/whatsapp";
import { createDunningSender, createMailer } from "./notifications.js";
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
// Construit au démarrage : en production, un expéditeur muet fait échouer le
// lancement (sauf ALLOW_INSECURE_MAIL=1), plutôt que d'avaler les relances.
const mailer = createMailer();
const dunningSender = createDunningSender({ mailer, whatsapp });

const packs = new Map<string, CountryPack>();

/** Service de facturation du dossier, avec l'expéditeur de relances branché. */
async function invoicingFor(tenantId: string, userId: string): Promise<InvoicingService> {
  const [company] = await withTenant(db, { tenantId, userId }, (tx) => tx`SELECT country_code, currency FROM company WHERE id = ${tenantId}`);
  if (!company) throw new InvoicingError("NOT_FOUND", `Dossier ${tenantId} introuvable`);
  const code = String(company.country_code).toLowerCase();
  let pack = packs.get(code);
  if (!pack) {
    pack = loadPack(code);
    packs.set(code, pack);
  }
  const currency = String(company.currency);
  const ledger = new Ledger(new PostgresStore(db as unknown as Sql, { userId }), { baseCurrency: currency });
  return new InvoicingService({ db: db as unknown as Sql, ledger, pack, currency, dunningSender }, { tenantId, userId });
}

/** Niveau suivant : une relance de plus que la dernière, plafonnée à la mise en demeure. */
async function nextDunningLevel(tenantId: string, invoiceId: string): Promise<number> {
  const [row] = await withTenant(db, { tenantId }, (tx) =>
    tx`SELECT coalesce(max(level), 0) AS level FROM dunning WHERE tenant_id = ${tenantId} AND sales_document_id = ${invoiceId}`,
  );
  return Math.min(Number(row?.level ?? 0) + 1, 3);
}

queue.process("document.extract", async (payload) => {
  const ctx = { tenantId: payload.tenantId, userId: payload.userId, ...(payload.organizationId ? { organizationId: payload.organizationId } : {}) };
  const documents = createDocumentsServiceFromEnv(db as unknown as Sql, ctx);
  await documents.extract(payload.documentId);
  await documents.propose(payload.documentId);
  log("info", "job.document.extract.done", { tenantId: payload.tenantId, documentId: payload.documentId });
});

queue.process("whatsapp.reply", async (payload) => {
  if (!whatsapp) {
    throw new Error("Canal WhatsApp non configuré : le message n'a pas été envoyé.");
  }
  await whatsapp.sendText(payload.to, payload.text);
});

/**
 * Relance d'une facture échue.
 *
 * `InvoicingService.recordDunning` remet d'abord le message au canal, puis
 * seulement écrit la ligne `dunning` : si l'envoi échoue, rien n'est enregistré
 * comme envoyé et la tentative part dans `dunning_log` (statut FAILED).
 *
 * Chemin d'échec : une panne du canal (DUNNING_NOT_SENT) est relancée — la
 * tâche remonte l'erreur, la file réessaie avec son délai croissant. Une erreur
 * définitive (facture soldée, tiers sans contact, dossier inconnu) ne se répare
 * pas par une nouvelle tentative : elle est journalisée en erreur et la tâche
 * s'arrête là, plutôt que de tourner jusqu'à épuisement des essais.
 */
queue.process("dunning.send", async (payload, ctx) => {
  const invoicing = await invoicingFor(payload.tenantId, payload.userId);
  const level = payload.level ?? (await nextDunningLevel(payload.tenantId, payload.invoiceId));
  try {
    const dunning = await invoicing.recordDunning(payload.invoiceId, {
      level,
      channel: payload.channel,
      ...(payload.message ? { message: payload.message } : {}),
    });
    log("info", "job.dunning.send.done", { tenantId: payload.tenantId, invoiceId: payload.invoiceId, channel: payload.channel, level: dunning.level });
  } catch (e) {
    const code = e instanceof InvoicingError ? e.code : "UNKNOWN";
    const detail = e instanceof Error ? e.message : String(e);
    if (code === "DUNNING_NOT_SENT" || code === "UNKNOWN") {
      log("warn", "job.dunning.send.retry", { tenantId: payload.tenantId, invoiceId: payload.invoiceId, attempt: ctx.attempt, code, detail });
      throw e; // panne du canal : la file réessaiera
    }
    log("error", "job.dunning.send.abandoned", { tenantId: payload.tenantId, invoiceId: payload.invoiceId, code, detail });
  }
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
