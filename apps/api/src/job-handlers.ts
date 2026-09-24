import type { Sql } from "postgres";
import { loadPack, type CountryPack } from "@arcompt/country-packs";
import { withTenant } from "@arcompt/db";
import { createDocumentsServiceFromEnv } from "@arcompt/documents";
import { InvoicingService } from "@arcompt/invoicing";
import type { JobQueue } from "@arcompt/jobs";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { TreasuryError, TreasuryService } from "@arcompt/treasury";
import { createProviderFromEnv } from "@arcompt/whatsapp";
import { createDunningSender, createMailer } from "./notifications.js";
import { log } from "./telemetry.js";

const packs = new Map<string, CountryPack>();

export function registerJobHandlers(queue: JobQueue, db: Sql): void {
  queue.process("document.extract", async (payload) => {
    const ctx = { tenantId: payload.tenantId, userId: payload.userId, ...(payload.organizationId ? { organizationId: payload.organizationId } : {}) };
    const documents = createDocumentsServiceFromEnv(db, ctx);
    const document = await documents.getDocument(payload.documentId);
    if (document.status === "PROPOSED" || document.status === "POSTED" || document.status === "REJECTED") return;
    if (document.status === "NEEDS_OCR") return;
    if (document.status !== "EXTRACTED") {
      const result = await documents.extract(payload.documentId);
      if (result.needsOcr) return;
    }
    await documents.propose(payload.documentId);
    log("info", "job.document.extract.done", { tenantId: payload.tenantId, documentId: payload.documentId });
  });

  queue.process("import.statement", async (payload) => {
    const ctx = { tenantId: payload.tenantId, userId: payload.userId, ...(payload.organizationId ? { organizationId: payload.organizationId } : {}) };
    const [company] = await withTenant(db, ctx, (tx) => tx`SELECT currency FROM company WHERE id = ${payload.tenantId}`);
    if (!company) throw new Error("Dossier introuvable");
    const ledger = new Ledger(new PostgresStore(db, { userId: payload.userId, ...(payload.organizationId ? { organizationId: payload.organizationId } : {}) }), { baseCurrency: String(company.currency) });
    const treasury = new TreasuryService({ db, ledger, ctx });
    try {
      await treasury.importStatement(payload.accountId, { csv: payload.csv }, { source: "CSV" });
    } catch (e) {
      // If a worker crashed after committing the import but before acknowledging
      // the job, the unique statement hash prevents a duplicate import.
      if (!(e instanceof TreasuryError && e.code === "DUPLICATE_STATEMENT")) throw e;
    }
    log("info", "job.import.statement.done", { tenantId: payload.tenantId, accountId: payload.accountId });
  });

  queue.process("dunning.send", async (payload) => {
    const [company] = await withTenant(db, { tenantId: payload.tenantId, userId: payload.userId },
      (tx) => tx`SELECT country_code, currency FROM company WHERE id = ${payload.tenantId}`);
    if (!company) throw new Error("Dossier introuvable");
    const code = String(company.country_code).toLowerCase();
    let pack = packs.get(code);
    if (!pack) { pack = loadPack(code); packs.set(code, pack); }
    const currency = String(company.currency);
    const ledger = new Ledger(new PostgresStore(db, { userId: payload.userId }), { baseCurrency: currency });
    const sender = createDunningSender({ mailer: createMailer(), whatsapp: createProviderFromEnv() });
    const invoicing = new InvoicingService({ db, ledger, pack, currency, dunningSender: sender }, { tenantId: payload.tenantId, userId: payload.userId });
    const [row] = await withTenant(db, { tenantId: payload.tenantId }, (tx) =>
      tx`SELECT coalesce(max(level), 0) AS level FROM dunning WHERE tenant_id = ${payload.tenantId} AND sales_document_id = ${payload.invoiceId}`);
    const level = payload.level ?? Math.min(Number(row?.level ?? 0) + 1, 3);
    await invoicing.recordDunning(payload.invoiceId, { level, channel: payload.channel, ...(payload.message ? { message: payload.message } : {}) });
    log("info", "job.dunning.send.done", { tenantId: payload.tenantId, invoiceId: payload.invoiceId });
  });
}