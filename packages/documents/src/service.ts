// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@arcompt/db";
import {
  AiGateway,
  DocumentExtractionSchema,
  EntryProposalSchema,
  checkExtractionArithmetic,
  checkProposal,
  duplicateKey,
  routeProposal,
  type DocumentExtraction,
  type GuardIssue,
} from "@arcompt/ai-gateway";
import { Money, type Actor, type JournalEntry, type JournalEntryInput, type Ledger } from "@arcompt/ledger";
import { sanitizeKey, type Storage } from "@arcompt/storage";
import type { Sql } from "postgres";
import { z } from "zod";
import { categorize, loadChart } from "./categorize.js";
import { DocumentsError } from "./errors.js";
import { CategorizationMemoryStore } from "./memory.js";
import { CAPTURE_PROMPT_VERSION, CAPTURE_SYSTEM } from "./prompts.js";
import { DEFAULT_MAX_DOCUMENT_BYTES, NoopScanner, detectFileType, findSuspiciousOutput, wrapUntrusted, type AntivirusScanner } from "./security.js";
import type {
  ChartAccountInfo,
  DocumentRecord,
  DocumentSource,
  ExtractedData,
  ProposalLine,
  ProposalRecord,
  ProposalRoute,
  ProposalStatus,
  StoredProposal,
  TenantContext,
} from "./types.js";

/** Contrôles propres au module, en plus des garde-fous de la passerelle. */
export type ProposalIssue = GuardIssue | { code: "SUSPICIOUS_OUTPUT" | "PERIOD_CLOSED" | "PARTNER_UNKNOWN"; message: string };

export interface DocumentsServiceOptions {
  db: Sql;
  ctx: TenantContext;
  storage: Storage;
  gateway: AiGateway;
  ledger: Ledger;
  baseCurrency: string;
  /** Le fournisseur accepte-t-il un PDF en pièce jointe ? Sinon le PDF est marqué « OCR requis ». */
  supportsPdf?: boolean;
  scanner?: AntivirusScanner;
  maxBytes?: number;
  now?: () => Date;
}

export interface UploadInput {
  bytes: Uint8Array;
  /** Type déclaré par le client : informatif seulement, le type réel est lu dans les octets. */
  mimeType?: string;
  filename?: string;
  source?: DocumentSource;
}

export interface ExtractResult {
  document: DocumentRecord;
  extraction: DocumentExtraction | null;
  issues: ProposalIssue[];
  needsOcr: boolean;
}

export interface CashExpenseInput {
  amount: string;
  label: string;
  means: "CASH" | "BANK" | "MOBILE_MONEY";
  date?: string;
  source?: DocumentSource;
  vatAmount?: string;
}

export interface ReviewQueueFilter {
  status?: ProposalStatus;
  route?: ProposalRoute | "ALL";
  source?: DocumentSource;
  limit?: number;
}

export interface ReviewQueueGroup {
  document: DocumentRecord | null;
  proposals: ProposalRecord[];
}

const CorrectedLinesSchema = z
  .array(
    EntryProposalSchema.shape.lines.element.extend({
      partner_id: z.string().uuid().optional(),
      partner_name: z.string().optional(),
    }),
  )
  .min(2);

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MEANS_ACCOUNT: Record<CashExpenseInput["means"], { account: string; journal: string; label: string }> = {
  CASH: { account: "571", journal: "CA", label: "Caisse" },
  BANK: { account: "521", journal: "BQ", label: "Banque" },
  MOBILE_MONEY: { account: "5381", journal: "BQ", label: "Mobile money" },
};

/**
 * Pièces justificatives et capture IA. Le tenant vient du contexte serveur ;
 * toute requête passe par withTenant (RLS). L'IA propose, l'humain valide :
 * seule `validate` / `correct` appelle Ledger.post (source AI).
 */
export class DocumentsService {
  private readonly db: Sql;
  readonly ctx: TenantContext;
  private readonly storage: Storage;
  private readonly gateway: AiGateway;
  private readonly ledger: Ledger;
  private readonly baseCurrency: string;
  private readonly supportsPdf: boolean;
  private readonly scanner: AntivirusScanner;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  readonly memory: CategorizationMemoryStore;

  constructor(opts: DocumentsServiceOptions) {
    this.db = opts.db;
    this.ctx = opts.ctx;
    this.storage = opts.storage;
    this.gateway = opts.gateway;
    this.ledger = opts.ledger;
    this.baseCurrency = opts.baseCurrency;
    this.supportsPdf = opts.supportsPdf ?? false;
    this.scanner = opts.scanner ?? new NoopScanner();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.now = opts.now ?? (() => new Date());
    this.memory = new CategorizationMemoryStore(opts.ctx.tenantId);
  }

  private tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant(this.db, this.ctx, fn);
  }

  private get actor(): Actor {
    return { userId: this.ctx.userId, tenantId: this.ctx.tenantId };
  }

  // -------------------------------------------------------------------------
  // Pièces
  // -------------------------------------------------------------------------

  /** Hash SHA-256, doublon par hash (renvoie l'existant), type réel, taille, antivirus, stockage, insertion. */
  async upload(input: UploadInput): Promise<{ document: DocumentRecord; duplicate: boolean }> {
    if (input.bytes.length === 0) throw new DocumentsError("EMPTY_FILE", "Fichier vide");
    if (input.bytes.length > this.maxBytes) {
      throw new DocumentsError("TOO_LARGE", `Fichier trop volumineux (${input.bytes.length} octets, maximum ${this.maxBytes})`, { max: this.maxBytes });
    }
    const type = detectFileType(input.bytes);
    if (!type) throw new DocumentsError("UNSUPPORTED_MIME", "Type de fichier non reconnu : PDF, JPEG, PNG ou WebP attendu", { declared: input.mimeType ?? null });
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const existing = await this.tx(async (tx) => {
      const rows = await tx`SELECT * FROM document WHERE tenant_id = ${this.ctx.tenantId} AND sha256 = ${sha256}`;
      return rows[0] ? mapDocument(rows[0]) : null;
    });
    if (existing) return { document: existing, duplicate: true };

    const scan = await this.scanner.scan(input.bytes);
    if (!scan.clean) throw new DocumentsError("INFECTED", `Fichier refusé par l'antivirus (${scan.signature ?? "signature inconnue"})`);

    const id = randomUUID();
    const baseName = (input.filename ?? `piece.${type.ext}`).replace(/\.[^.]*$/, "") || "piece";
    const storageKey = sanitizeKey(`${this.ctx.tenantId}/documents/${id}/${baseName}.${type.ext}`);
    await this.storage.put(storageKey, input.bytes, { contentType: type.mime });
    const document = await this.tx(async (tx) => {
      const [row] = await tx`
        INSERT INTO document (id, tenant_id, storage_key, sha256, mime_type, size_bytes, filename, source, status, uploaded_by)
        VALUES (${id}, ${this.ctx.tenantId}, ${storageKey}, ${sha256}, ${type.mime}, ${input.bytes.length}, ${input.filename ?? null}, ${input.source ?? "UPLOAD"}, 'UPLOADED', ${this.ctx.userId})
        RETURNING *`;
      await this.audit(tx, "document.upload", "document", id, { sha256, mime: type.mime, size: input.bytes.length, source: input.source ?? "UPLOAD" });
      return mapDocument(row!);
    });
    return { document, duplicate: false };
  }

  async getDocument(id: string): Promise<DocumentRecord> {
    const doc = await this.tx(async (tx) => {
      const rows = await tx`SELECT * FROM document WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id}`;
      return rows[0] ? mapDocument(rows[0]) : null;
    });
    if (!doc) throw new DocumentsError("DOCUMENT_NOT_FOUND", `Pièce ${id} introuvable`);
    return doc;
  }

  /** Octets de la pièce (servis par l'API, jamais depuis l'origine de l'application). */
  async downloadBytes(id: string): Promise<{ document: DocumentRecord; bytes: Uint8Array; contentType: string }> {
    const document = await this.getDocument(id);
    const obj = await this.storage.get(document.storageKey);
    if (!obj) throw new DocumentsError("DOCUMENT_NOT_FOUND", `Fichier de la pièce ${id} absent du stockage`);
    return { document, bytes: obj.bytes, contentType: obj.contentType };
  }

  async downloadUrl(id: string, ttlSeconds = 300): Promise<{ document: DocumentRecord; url: string }> {
    const document = await this.getDocument(id);
    return { document, url: await this.storage.signedUrl(document.storageKey, ttlSeconds) };
  }

  // -------------------------------------------------------------------------
  // Extraction
  // -------------------------------------------------------------------------

  /** Lecture de la pièce par le modèle vision, contrôle HT + TVA = TTC, doublon (tiers, montant, date), filtre d'injection. */
  async extract(documentId: string): Promise<ExtractResult> {
    const document = await this.getDocument(documentId);
    const obj = await this.storage.get(document.storageKey);
    if (!obj) throw new DocumentsError("DOCUMENT_NOT_FOUND", `Fichier de la pièce ${documentId} absent du stockage`);
    const mime = document.mimeType;
    const isImage = IMAGE_MIMES.has(mime);
    const isPdf = mime === "application/pdf";
    if (!isImage && !isPdf) throw new DocumentsError("UNSUPPORTED_MIME", `Type ${mime} non pris en charge par la capture`);
    if (isPdf && !this.supportsPdf) {
      const extracted: ExtractedData = { ...emptyExtraction(), needs_ocr: true, extracted_at: this.now().toISOString(), prompt_version: CAPTURE_PROMPT_VERSION };
      const updated = await this.tx(async (tx) => {
        const [row] = await tx`UPDATE document SET extracted = ${tx.json(extracted as never)}, status = 'NEEDS_OCR' WHERE tenant_id = ${this.ctx.tenantId} AND id = ${documentId} RETURNING *`;
        return mapDocument(row!);
      });
      return { document: updated, extraction: null, issues: [], needsOcr: true };
    }

    const hint = document.filename ? wrapUntrusted(`Nom du fichier : ${document.filename}`) : null;
    const { data: raw } = await this.gateway.callJson(
      { tenantId: this.ctx.tenantId, userId: this.ctx.userId },
      {
        capability: "capture",
        promptVersion: CAPTURE_PROMPT_VERSION,
        system: CAPTURE_SYSTEM,
        input: { task: "Extrais les données de la pièce jointe.", document: hint, mime },
        images: [{ mediaType: mime, data: Buffer.from(obj.bytes).toString("base64") }],
        maxTokens: 2048,
      },
      DocumentExtractionSchema,
    );
    const data: DocumentExtraction = { ...raw, lines: raw.lines ?? [] };

    const issues: ProposalIssue[] = [...checkExtractionArithmetic(data)];
    const suspicion = findSuspiciousOutput(data, [document.filename ?? ""]);
    if (suspicion.suspicious) {
      issues.push({ code: "SUSPICIOUS_OUTPUT", message: `Sortie suspecte (coordonnées absentes de l'entrée : ${suspicion.patterns.join(", ")}) : revue humaine` });
    }
    const key = duplicateKey(data);
    const duplicateOf = key ? await this.findDuplicate(key, documentId) : null;
    if (duplicateOf) issues.push({ code: "DUPLICATE", message: `Pièce probablement déjà saisie (même tiers, montant et date)` });

    const extracted: ExtractedData = {
      ...data,
      duplicate_key: key,
      duplicate_of: duplicateOf,
      issues: issues as GuardIssue[],
      needs_ocr: false,
      extracted_at: this.now().toISOString(),
      prompt_version: CAPTURE_PROMPT_VERSION,
    };
    const updated = await this.tx(async (tx) => {
      const [row] = await tx`UPDATE document SET extracted = ${tx.json(extracted as never)}, status = 'EXTRACTED' WHERE tenant_id = ${this.ctx.tenantId} AND id = ${documentId} RETURNING *`;
      return mapDocument(row!);
    });
    return { document: updated, extraction: data, issues, needsOcr: false };
  }

  private findDuplicate(key: string, excludeDocumentId: string | null): Promise<{ document_id?: string; proposal_id?: string } | null> {
    return this.tx(async (tx) => {
      const docs = await tx`
        SELECT id FROM document WHERE tenant_id = ${this.ctx.tenantId} AND extracted->>'duplicate_key' = ${key} AND id <> ${excludeDocumentId ?? "00000000-0000-0000-0000-000000000000"} LIMIT 1`;
      if (docs[0]) return { document_id: docs[0].id as string };
      const props = await tx`
        SELECT id FROM ai_proposal WHERE tenant_id = ${this.ctx.tenantId} AND extraction->>'duplicate_key' = ${key} AND status <> 'REJECTED'
           AND (document_id IS NULL OR document_id <> ${excludeDocumentId ?? "00000000-0000-0000-0000-000000000000"}) LIMIT 1`;
      if (props[0]) return { proposal_id: props[0].id as string };
      return null;
    });
  }

  // -------------------------------------------------------------------------
  // Proposition
  // -------------------------------------------------------------------------

  /** Catégorisation (règles → mémoire → modèle) puis proposition d'écriture d'achat, contrôlée et routée. */
  async propose(documentId: string): Promise<ProposalRecord> {
    const document = await this.getDocument(documentId);
    const x = document.extracted;
    if (!x || x.needs_ocr) throw new DocumentsError(x?.needs_ocr ? "NEEDS_OCR" : "NOT_EXTRACTED", "Pièce non lue : lancez l'extraction d'abord");
    const amounts = resolveAmounts(x);
    if (!amounts) throw new DocumentsError("NO_AMOUNT", "Aucun montant lisible : saisie manuelle requise");

    const description = [x.lines.map((l) => l.description).join(" ; "), x.notes ?? "", x.reference ?? ""].filter(Boolean).join(" | ");
    const supplierName = x.supplier_name?.trim() || null;

    return this.tx(async (tx) => {
      const chart = await loadChart(tx, this.ctx.tenantId);
      const cat = await categorize(tx, { ctx: this.ctx, gateway: this.gateway, memory: this.memory }, { partnerName: supplierName, description: wrapUntrusted(description), amount: amounts.ttc.toString(), documentType: x.document_type }, chart);

      const issues: ProposalIssue[] = [...(x.issues ?? [])];
      const date = x.date ?? this.now().toISOString().slice(0, 10);
      const isReceipt = x.document_type === "RECEIPT";
      const lines: ProposalLine[] = [{ account_number: cat.accountNumber, debit: amounts.ht.toString(), label: supplierName ? `${supplierName} – ${x.reference ?? description.slice(0, 60)}` : description.slice(0, 80), ...accountLabel(chart, cat.accountNumber) }];
      if (!amounts.vat.isZero()) lines.push({ account_number: "445", debit: amounts.vat.toString(), label: "TVA récupérable", ...(cat.vatCode ? { vat_code: cat.vatCode } : {}) });
      if (isReceipt) {
        lines.push({ account_number: "571", credit: amounts.ttc.toString(), label: "Caisse" });
      } else {
        const partner = await this.resolvePartner(tx, supplierName);
        if (!supplierName) issues.push({ code: "PARTNER_UNKNOWN", message: "Fournisseur non identifié sur la pièce : tiers provisoire" });
        lines.push({ account_number: "401", credit: amounts.ttc.toString(), partner_id: partner.id, partner_name: partner.name, label: partner.name });
      }
      const confidence = Math.min(x.confidence, cat.confidence, supplierName || isReceipt ? 1 : 0.6);
      const proposal: StoredProposal = {
        journal_code: isReceipt ? "CA" : "AC",
        date,
        label: `${isReceipt ? "Reçu" : "Facture"} ${supplierName ?? "fournisseur"}${x.reference ? ` ${x.reference}` : ""}`.trim(),
        reference: x.reference ?? null,
        lines,
        confidence,
        rationale: cat.rationale,
        alternatives: [],
        categorized_by: cat.by,
      };
      return this.storeProposal(tx, { documentId, source: document.source, extraction: x, proposal, issues, chart });
    });
  }

  /** Dépense saisie en texte (WhatsApp : « j'ai payé 50 000 de carburant en espèces ») → 6xx / 571. */
  async proposeCashExpense(input: CashExpenseInput): Promise<ProposalRecord> {
    const ttc = Money.parse(input.amount);
    const vat = Money.parse(input.vatAmount ?? "0");
    const ht = ttc.sub(vat);
    if (!ttc.isPositive()) throw new DocumentsError("NO_AMOUNT", "Montant nul ou négatif");
    const means = MEANS_ACCOUNT[input.means];
    return this.tx(async (tx) => {
      const chart = await loadChart(tx, this.ctx.tenantId);
      const cat = await categorize(tx, { ctx: this.ctx, gateway: this.gateway, memory: this.memory }, { partnerName: null, description: wrapUntrusted(input.label), amount: ttc.toString(), documentType: "RECEIPT" }, chart);
      const lines: ProposalLine[] = [{ account_number: cat.accountNumber, debit: ht.toString(), label: input.label, ...accountLabel(chart, cat.accountNumber) }];
      if (!vat.isZero()) lines.push({ account_number: "445", debit: vat.toString(), label: "TVA récupérable", ...(cat.vatCode ? { vat_code: cat.vatCode } : {}) });
      lines.push({ account_number: means.account, credit: ttc.toString(), label: means.label });
      const extraction: ExtractedData = {
        ...emptyExtraction(),
        document_type: "RECEIPT",
        date: input.date ?? this.now().toISOString().slice(0, 10),
        currency: this.baseCurrency,
        amount_excl_tax: ht.toString(),
        vat_amount: vat.toString(),
        amount_incl_tax: ttc.toString(),
        lines: [{ description: input.label, quantity: null, unit_price: null, amount: ttc.toString() }],
        confidence: 1,
        notes: "Saisie texte",
        duplicate_key: duplicateKey({ supplier_name: input.label, amount_incl_tax: ttc.toString(), date: input.date ?? this.now().toISOString().slice(0, 10) }),
      };
      const proposal: StoredProposal = {
        journal_code: means.journal,
        date: extraction.date!,
        label: input.label,
        lines,
        confidence: cat.confidence,
        rationale: cat.rationale,
        alternatives: [],
        categorized_by: cat.by,
      };
      return this.storeProposal(tx, { documentId: null, source: input.source ?? "WHATSAPP", extraction, proposal, issues: [], chart });
    });
  }

  private async storeProposal(
    tx: Sql,
    p: { documentId: string | null; source: DocumentSource; extraction: ExtractedData; proposal: StoredProposal; issues: ProposalIssue[]; chart: Map<string, ChartAccountInfo> },
  ): Promise<ProposalRecord> {
    const issues = [...p.issues];
    const guard = checkProposal(p.proposal, (n) => {
      const a = p.chart.get(n);
      return a && a.active ? { postable: a.postable } : null;
    });
    issues.push(...guard);
    const period = await tx`SELECT status FROM period WHERE tenant_id = ${this.ctx.tenantId} AND ${p.proposal.date}::date BETWEEN start_date AND end_date`;
    const periodStatus = (period[0]?.status as string | undefined) ?? null;
    if (periodStatus !== "OPEN") {
      issues.push({ code: "PERIOD_CLOSED", message: periodStatus ? `Période de la date ${p.proposal.date} ${periodStatus === "CLOSED" ? "clôturée" : "verrouillée"} : proposition rejetée` : `Aucune période ouverte pour la date ${p.proposal.date}` });
    }
    const route = routeIssues(issues);
    const autoReject = issues.some((i) => i.code === "PERIOD_CLOSED");
    const [row] = await tx`
      INSERT INTO ai_proposal (tenant_id, document_id, source, kind, extraction, proposal, confidence, guard_issues, route, status, decided_at, created_by)
      VALUES (${this.ctx.tenantId}, ${p.documentId}, ${p.source}, 'ENTRY', ${tx.json(p.extraction as never)}, ${tx.json(p.proposal as never)}, ${p.proposal.confidence},
              ${tx.json(issues as never)}, ${route}, ${autoReject ? "REJECTED" : "PENDING"}, ${autoReject ? this.now().toISOString() : null}, ${this.ctx.userId})
      RETURNING *`;
    if (p.documentId) await tx`UPDATE document SET status = ${autoReject ? "REJECTED" : "PROPOSED"} WHERE tenant_id = ${this.ctx.tenantId} AND id = ${p.documentId}`;
    return mapProposal(row!);
  }

  private async resolvePartner(tx: Sql, name: string | null): Promise<{ id: string; name: string }> {
    const label = name ?? "Fournisseur à identifier";
    const rows = await tx`SELECT id, name FROM partner WHERE tenant_id = ${this.ctx.tenantId} AND type = 'SUPPLIER' AND lower(name) = lower(${label}) LIMIT 1`;
    if (rows[0]) return { id: rows[0].id as string, name: rows[0].name as string };
    const [row] = await tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${this.ctx.tenantId}, 'SUPPLIER', ${label}, '401') RETURNING id, name`;
    return { id: row!.id as string, name: row!.name as string };
  }

  // -------------------------------------------------------------------------
  // Décision humaine
  // -------------------------------------------------------------------------

  async getProposal(id: string): Promise<ProposalRecord> {
    const p = await this.tx(async (tx) => {
      const rows = await tx`SELECT * FROM ai_proposal WHERE tenant_id = ${this.ctx.tenantId} AND id = ${id}`;
      return rows[0] ? mapProposal(rows[0]) : null;
    });
    if (!p) throw new DocumentsError("PROPOSAL_NOT_FOUND", `Proposition ${id} introuvable`);
    return p;
  }

  /** Comptabilise la proposition telle quelle (source AI) et mémorise la validation. */
  async validate(proposalId: string, actor: Actor = this.actor): Promise<{ proposal: ProposalRecord; entry: JournalEntry }> {
    const p = await this.getProposal(proposalId);
    if (p.status !== "PENDING") throw new DocumentsError("PROPOSAL_NOT_PENDING", `Proposition déjà ${labelStatus(p.status)}`);
    if (p.route === "REJECTED") throw new DocumentsError("PROPOSAL_REJECTED_BY_GUARD", "Proposition rejetée par les contrôles : corrigez-la avant de la comptabiliser", { issues: p.guardIssues });
    const entry = await this.ledger.post(actor, toEntryInput(p.proposal, p.proposal.lines));
    const updated = await this.decide(p, "VALIDATED", entry, null, actor);
    return { proposal: updated, entry };
  }

  /** Comptabilise des lignes corrigées par l'humain et mémorise la correction pour les prochaines propositions. */
  async correct(proposalId: string, correctedLines: ProposalLine[], actor: Actor = this.actor): Promise<{ proposal: ProposalRecord; entry: JournalEntry }> {
    const p = await this.getProposal(proposalId);
    if (p.status !== "PENDING") throw new DocumentsError("PROPOSAL_NOT_PENDING", `Proposition déjà ${labelStatus(p.status)}`);
    const parsed = CorrectedLinesSchema.safeParse(correctedLines);
    if (!parsed.success) throw new DocumentsError("INVALID_LINES", "Lignes corrigées invalides", { issues: parsed.error.issues });
    // Un compte lettrable garde le tiers de la proposition d'origine si la correction n'en précise pas.
    const lines: ProposalLine[] = parsed.data.map((l) => {
      const original = p.proposal.lines.find((o) => o.account_number === l.account_number && o.partner_id);
      const clean = Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)) as ProposalLine;
      return original?.partner_id && !clean.partner_id ? { ...clean, partner_id: original.partner_id } : clean;
    });
    const entry = await this.ledger.post(actor, toEntryInput(p.proposal, lines));
    const updated = await this.decide(p, "CORRECTED", entry, lines, actor);
    return { proposal: updated, entry };
  }

  async reject(proposalId: string, reason?: string, actor: Actor = this.actor): Promise<ProposalRecord> {
    const p = await this.getProposal(proposalId);
    if (p.status !== "PENDING") throw new DocumentsError("PROPOSAL_NOT_PENDING", `Proposition déjà ${labelStatus(p.status)}`);
    return this.tx(async (tx) => {
      const at = this.now().toISOString();
      const [row] = await tx`
        UPDATE ai_proposal SET status = 'REJECTED', decided_by = ${actor.userId}, decided_at = ${at}, correction = ${reason ? tx.json({ reason }) : null}
         WHERE tenant_id = ${this.ctx.tenantId} AND id = ${proposalId} RETURNING *`;
      if (p.documentId) await tx`UPDATE document SET status = 'REJECTED' WHERE tenant_id = ${this.ctx.tenantId} AND id = ${p.documentId} AND status = 'PROPOSED'`;
      await this.audit(tx, "proposal.reject", "ai_proposal", proposalId, { reason: reason ?? null }, actor.userId, at);
      return mapProposal(row!);
    });
  }

  private decide(p: ProposalRecord, status: "VALIDATED" | "CORRECTED", entry: JournalEntry, correction: ProposalLine[] | null, actor: Actor): Promise<ProposalRecord> {
    return this.tx(async (tx) => {
      const at = this.now().toISOString();
      const [row] = await tx`
        UPDATE ai_proposal SET status = ${status}, decided_by = ${actor.userId}, decided_at = ${at}, entry_id = ${entry.id}, correction = ${correction ? tx.json(correction as never) : null}
         WHERE tenant_id = ${this.ctx.tenantId} AND id = ${p.id} RETURNING *`;
      if (p.documentId) await tx`UPDATE document SET status = 'POSTED', entry_id = ${entry.id} WHERE tenant_id = ${this.ctx.tenantId} AND id = ${p.documentId}`;
      const lines = correction ?? p.proposal.lines;
      const categorized = lines.find((l) => /^[67]/.test(l.account_number)) ?? lines.find((l) => !/^(401|445|411|443|5)/.test(l.account_number));
      if (categorized) {
        const partnerName = p.extraction?.supplier_name ?? lines.find((l) => l.partner_name)?.partner_name ?? null;
        const description = p.extraction?.lines.map((l) => l.description).join(" ; ") || p.proposal.label;
        await this.memory.record(tx, {
          partnerName,
          description,
          accountNumber: categorized.account_number,
          vatCode: lines.find((l) => l.vat_code)?.vat_code ?? null,
          source: status === "CORRECTED" ? "HUMAN_CORRECTION" : "HUMAN_VALIDATION",
        });
      }
      await this.audit(tx, status === "CORRECTED" ? "proposal.correct" : "proposal.validate", "ai_proposal", p.id, { entryId: entry.id, number: entry.number, journal: entry.journalCode }, actor.userId, at);
      return mapProposal(row!);
    });
  }

  /** File de revue du comptable : propositions en attente, groupées par pièce. */
  async reviewQueue(filter: ReviewQueueFilter = {}): Promise<ReviewQueueGroup[]> {
    const status = filter.status ?? "PENDING";
    const route = filter.route ?? "REVIEW_QUEUE";
    const limit = Math.min(filter.limit ?? 100, 500);
    return this.tx(async (tx) => {
      const rows = await tx`
        SELECT * FROM ai_proposal
         WHERE tenant_id = ${this.ctx.tenantId} AND status = ${status}
           ${route === "ALL" ? tx`` : tx`AND route = ${route}`}
           ${filter.source ? tx`AND source = ${filter.source}` : tx``}
         ORDER BY created_at DESC LIMIT ${limit}`;
      const proposals = rows.map(mapProposal);
      const docIds = [...new Set(proposals.map((p) => p.documentId).filter((d): d is string => d !== null))];
      const docs = docIds.length ? (await tx`SELECT * FROM document WHERE tenant_id = ${this.ctx.tenantId} AND id IN ${tx(docIds)}`).map(mapDocument) : [];
      const byDoc = new Map(docs.map((d) => [d.id, d]));
      const groups = new Map<string, ReviewQueueGroup>();
      for (const p of proposals) {
        const key = p.documentId ?? `proposal:${p.id}`;
        const g = groups.get(key) ?? { document: p.documentId ? (byDoc.get(p.documentId) ?? null) : null, proposals: [] };
        g.proposals.push(p);
        groups.set(key, g);
      }
      return [...groups.values()];
    });
  }

  async bulkValidate(ids: string[], actor: Actor = this.actor): Promise<Array<{ id: string; ok: boolean; entryId?: string; error?: { code: string; message: string } }>> {
    const out: Array<{ id: string; ok: boolean; entryId?: string; error?: { code: string; message: string } }> = [];
    for (const id of ids) {
      try {
        const { entry } = await this.validate(id, actor);
        out.push({ id, ok: true, entryId: entry.id });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        out.push({ id, ok: false, error: { code: err.code ?? "INTERNAL", message: err.message ?? String(e) } });
      }
    }
    return out;
  }

  private async audit(tx: Sql, action: string, entity: string, entityId: string, after: unknown, userId = this.ctx.userId, at = this.now().toISOString()): Promise<void> {
    await tx`INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after, at) VALUES (${this.ctx.tenantId}, ${userId}, ${action}, ${entity}, ${entityId}, ${tx.json(after as never)}, ${at})`;
  }
}

// ---------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------

/** Routage : rejet sur les contrôles bloquants, revue sur tout autre signal, sinon validation en un geste. */
export function routeIssues(issues: ProposalIssue[]): ProposalRoute {
  if (issues.some((i) => i.code === "PERIOD_CLOSED")) return "REJECTED";
  const guard = issues.filter((i): i is GuardIssue => !["SUSPICIOUS_OUTPUT", "PERIOD_CLOSED", "PARTNER_UNKNOWN"].includes(i.code));
  const base = routeProposal(guard);
  if (base === "REJECTED") return "REJECTED";
  return issues.length > 0 ? "REVIEW_QUEUE" : "ONE_TAP_VALIDATION";
}

function resolveAmounts(x: ExtractedData): { ht: Money; vat: Money; ttc: Money } | null {
  const vat = Money.parse(x.vat_amount ?? "0");
  if (x.amount_incl_tax && x.amount_excl_tax) return { ht: Money.parse(x.amount_excl_tax), vat, ttc: Money.parse(x.amount_incl_tax) };
  if (x.amount_incl_tax) {
    const ttc = Money.parse(x.amount_incl_tax);
    return { ht: ttc.sub(vat), vat, ttc };
  }
  if (x.amount_excl_tax) {
    const ht = Money.parse(x.amount_excl_tax);
    return { ht, vat, ttc: ht.add(vat) };
  }
  return null;
}

function toEntryInput(p: StoredProposal, lines: ProposalLine[]): JournalEntryInput {
  return {
    journalCode: p.journal_code,
    date: p.date,
    label: p.label,
    source: "AI",
    ...(p.reference ? { reference: p.reference } : {}),
    lines: lines.map((l) => ({
      accountNumber: l.account_number,
      ...(l.debit ? { debit: l.debit } : {}),
      ...(l.credit ? { credit: l.credit } : {}),
      ...(l.partner_id ? { partnerId: l.partner_id } : {}),
      ...(l.label ? { label: l.label } : {}),
      ...(l.vat_code ? { vatCode: l.vat_code } : {}),
    })),
  };
}

function accountLabel(chart: Map<string, ChartAccountInfo>, number: string): { account_label?: string } {
  const label = chart.get(number)?.label;
  return label ? { account_label: label } : {};
}

function emptyExtraction(): DocumentExtraction {
  return { document_type: "OTHER", supplier_name: null, supplier_tax_id: null, customer_name: null, reference: null, date: null, currency: null, amount_excl_tax: null, vat_amount: null, amount_incl_tax: null, lines: [], confidence: 0, notes: null };
}

function labelStatus(s: ProposalStatus): string {
  return s === "VALIDATED" ? "validée" : s === "CORRECTED" ? "corrigée" : s === "REJECTED" ? "rejetée" : "en attente";
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export function mapDocument(r: Record<string, unknown>): DocumentRecord {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    entryId: (r.entry_id as string | null) ?? null,
    storageKey: r.storage_key as string,
    sha256: r.sha256 as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
    filename: (r.filename as string | null) ?? null,
    source: r.source as DocumentSource,
    status: r.status as DocumentRecord["status"],
    extracted: (r.extracted as ExtractedData | null) ?? null,
    uploadedBy: r.uploaded_by as string,
    createdAt: toIso(r.created_at)!,
  };
}

export function mapProposal(r: Record<string, unknown>): ProposalRecord {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    documentId: (r.document_id as string | null) ?? null,
    source: r.source as DocumentSource,
    kind: r.kind as ProposalRecord["kind"],
    extraction: (r.extraction as ExtractedData | null) ?? null,
    proposal: r.proposal as StoredProposal,
    confidence: Number(r.confidence),
    guardIssues: (r.guard_issues as GuardIssue[]) ?? [],
    route: r.route as ProposalRoute,
    status: r.status as ProposalStatus,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: toIso(r.decided_at),
    entryId: (r.entry_id as string | null) ?? null,
    correction: Array.isArray(r.correction) ? (r.correction as ProposalLine[]) : null,
    createdAt: toIso(r.created_at)!,
  };
}
