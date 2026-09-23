// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { z } from "zod";
import { withTenant, type Db } from "@arcompt/db";
import { assertPackPublished, loadPack as defaultLoadPack, PackNotPublishedError, type CountryPack } from "@arcompt/country-packs";
import { legalFooterFromEnv, missingDocumentMail, resolveLocale } from "@arcompt/mailer";
import { computeDegressiveInvoice, type DegressiveInvoice, type PricingMode } from "./billing.js";
import { nextDeadlines } from "./deadlines.js";
import { PortalError } from "./errors.js";
import type { Notifier } from "./notifier.js";
import { audit, int, iso, isoOrNull, str, strOrNull, type Row } from "./sql.js";
import type {
  Comment,
  CommentEntityKind,
  DashboardRow,
  Filing,
  FilingFormat,
  FilingKind,
  FilingStatus,
  MessageChannel,
  MissingDocumentRequest,
  OrganizationContext,
  ReviewQueue,
  TenantContext,
  UsageCounters,
  UsageQuotas,
  UsageReport,
  WhiteLabelSettings,
} from "./types.js";

export const WhiteLabelSchema = z.object({
  brandName: z.string().min(1).max(80).nullable().default(null),
  logoDocumentId: z.string().uuid().nullable().default(null),
  colours: z
    .object({
      primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
    })
    .default({}),
  senderName: z.string().min(1).max(80).nullable().default(null),
});

const QuotasSchema = z.object({
  aiCalls: z.number().int().nonnegative().nullable().default(null),
  documents: z.number().int().nonnegative().nullable().default(null),
  whatsappMessages: z.number().int().nonnegative().nullable().default(null),
});

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface OrganizationInvoice extends DegressiveInvoice {
  organizationId: string;
  month: string;
  planCode: string;
  currency: string;
  activeDossiers: number;
}

export interface PortalServiceOptions {
  notifier: Notifier;
  loadPack?: (code: string) => CountryPack;
  /** Environnement lu par la garde des documents légaux (ALLOW_INSECURE_DRAFT_PACK_FILINGS) ; `process.env` par défaut. */
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Mentions légales en pied des e-mails ; défaut : `MAIL_LEGAL_FOOTER`. */
  legalFooter?: string;
  /** Horizon des échéances affichées sur le tableau de bord (jours). */
  deadlineHorizonDays?: number;
}

/**
 * Vues multi-dossiers d'un cabinet et collaboration autour d'un dossier.
 *
 *  - niveau organisation (dashboard, file de revue, facturation, marque blanche) :
 *    contexte { organizationId } → RLS sur app_organization_id(), et
 *    portal_dashboard() (SECURITY DEFINER, refuse toute autre organisation) ;
 *  - niveau dossier (commentaires, pièces manquantes, dépôts, usage) :
 *    contexte { tenantId } → withTenant, RLS sur app_tenant_id().
 */
export class PortalService {
  private readonly loadPack: (code: string) => CountryPack;
  private readonly packs = new Map<string, CountryPack | null>();
  private readonly now: () => Date;
  private readonly horizon: number;
  private readonly env: Record<string, string | undefined> | undefined;

  constructor(
    private readonly db: Db,
    private readonly opts: PortalServiceOptions,
  ) {
    this.loadPack = opts.loadPack ?? defaultLoadPack;
    this.now = opts.now ?? (() => new Date());
    this.horizon = opts.deadlineHorizonDays ?? 90;
    this.env = opts.env;
  }

  // ---------------------------------------------------------------- tableau de bord

  /** Une ligne par dossier de l'organisation, avec les prochaines échéances du pack pays. */
  async dashboard(ctx: OrganizationContext): Promise<DashboardRow[]> {
    const rows = await withTenant(this.db, orgCtx(ctx), (tx) => tx`SELECT portal_dashboard(${ctx.organizationId}) AS row`);
    const today = this.now();
    return rows.map((r) => {
      const d = r.row as Record<string, unknown>;
      const countryCode = str(d.countryCode);
      const pack = this.pack(countryCode.toLowerCase());
      return {
        companyId: str(d.companyId),
        name: str(d.name),
        countryCode,
        currency: str(d.currency),
        accountingSystem: str(d.accountingSystem) as "NORMAL" | "SMT",
        packVersion: str(d.packVersion),
        lastEntryDate: strOrNull(d.lastEntryDate),
        draftCount: int(d.draftCount),
        validatedCount: int(d.validatedCount),
        pendingProposals: d.pendingProposals === null || d.pendingProposals === undefined ? null : int(d.pendingProposals),
        openPeriods: int(d.openPeriods),
        fiscalYear: (d.fiscalYear as DashboardRow["fiscalYear"]) ?? null,
        workflowState: strOrNull(d.workflowState),
        anomalies: int(d.anomalies),
        unresolvedComments: int(d.unresolvedComments),
        missingDocuments: int(d.missingDocuments),
        nextDeadlines: pack ? nextDeadlines(pack, today, this.horizon) : [],
      };
    });
  }

  /**
   * File de revue : propositions IA en attente, groupées par dossier. Si le
   * module documents n'est pas installé (table ai_proposal absente), la file
   * est vide et `available` vaut false, sans erreur.
   */
  async reviewQueue(ctx: OrganizationContext, opts: { limitPerCompany?: number } = {}): Promise<ReviewQueue> {
    const limit = opts.limitPerCompany ?? 50;
    const { available, companies } = await withTenant(this.db, orgCtx(ctx), async (tx) => {
      const [probe] = await tx`SELECT to_regclass('public.ai_proposal') IS NOT NULL AS present`;
      const companies = await tx`SELECT id, name FROM company WHERE organization_id = ${ctx.organizationId} ORDER BY name`;
      return { available: Boolean(probe?.present), companies };
    });
    if (!available) return { available: false, totalPending: 0, companies: [] };
    const out: ReviewQueue["companies"] = [];
    let total = 0;
    for (const c of companies) {
      const companyId = str(c.id);
      const { pending, proposals } = await withTenant(this.db, { tenantId: companyId, organizationId: ctx.organizationId }, async (tx) => {
        const [count] = await tx`SELECT count(*)::int AS n FROM ai_proposal WHERE tenant_id = ${companyId} AND status = 'PENDING'`;
        const rows = await tx`SELECT to_jsonb(p) AS proposal FROM ai_proposal p WHERE tenant_id = ${companyId} AND status = 'PENDING' ORDER BY created_at LIMIT ${limit}`;
        return { pending: int(count?.n), proposals: rows.map((r) => r.proposal as Record<string, unknown>) };
      });
      total += pending;
      out.push({ companyId, name: str(c.name), pending, proposals });
    }
    return { available: true, totalPending: total, companies: out };
  }

  // ---------------------------------------------------------------- commentaires

  async listComments(ctx: TenantContext, filter: { entityKind?: CommentEntityKind; entityId?: string; resolved?: boolean } = {}): Promise<Comment[]> {
    const rows = await withTenant(this.db, ctx, (tx) =>
      tx`SELECT * FROM company_comment WHERE tenant_id = ${ctx.tenantId}
         ${filter.entityKind ? tx`AND entity_kind = ${filter.entityKind}` : tx``}
         ${filter.entityId ? tx`AND entity_id = ${filter.entityId}` : tx``}
         ${filter.resolved === undefined ? tx`` : tx`AND resolved = ${filter.resolved}`}
         ORDER BY created_at`,
    );
    return rows.map(mapComment);
  }

  async createComment(ctx: TenantContext, input: { entityKind: CommentEntityKind; entityId: string; body: string }): Promise<Comment> {
    const body = input.body.trim();
    if (!body) throw new PortalError("VALIDATION", "Commentaire vide");
    const [row] = await withTenant(this.db, ctx, (tx) =>
      tx`INSERT INTO company_comment (tenant_id, entity_kind, entity_id, author_id, body)
         VALUES (${ctx.tenantId}, ${input.entityKind}, ${input.entityId}, ${ctx.userId}, ${body}) RETURNING *`,
    );
    return mapComment(row!);
  }

  async resolveComment(ctx: TenantContext, commentId: string, resolved = true): Promise<Comment> {
    const [row] = await withTenant(this.db, ctx, (tx) =>
      tx`UPDATE company_comment
         SET resolved = ${resolved}, resolved_by = ${resolved ? ctx.userId : null}, resolved_at = ${resolved ? tx`now()` : null}
         WHERE id = ${commentId} AND tenant_id = ${ctx.tenantId} RETURNING *`,
    );
    if (!row) throw new PortalError("NOT_FOUND", "Commentaire introuvable");
    return mapComment(row);
  }

  // ---------------------------------------------------------------- pièces manquantes

  /**
   * Enregistre une demande de pièce et l'envoie par WhatsApp ou e-mail via le
   * Notifier. Sans destinataire explicite, le contact du tiers est utilisé
   * (partner.contact.whatsapp / .phone / .email). En cas d'échec d'envoi la
   * demande reste enregistrée (sent_at null) et NOTIFY_FAILED est levée.
   */
  async requestMissingDocument(
    ctx: TenantContext,
    input: { partnerId?: string; entryId?: string; description: string; channel: MessageChannel; recipient?: string },
  ): Promise<MissingDocumentRequest> {
    const description = input.description.trim();
    if (!description) throw new PortalError("VALIDATION", "Description de la pièce requise");
    const { row, partnerName, brand, locale } = await withTenant(this.db, ctx, async (tx) => {
      let recipient = input.recipient?.trim() ?? "";
      let partnerName: string | null = null;
      // La demande est adressée AU TIERS : sa langue passe avant celle du dossier.
      let recipientLocale: string | null = null;
      if (input.partnerId) {
        const [p] = await tx`SELECT name, contact FROM partner WHERE id = ${input.partnerId} AND tenant_id = ${ctx.tenantId}`;
        if (!p) throw new PortalError("NOT_FOUND", "Tiers introuvable");
        partnerName = str(p.name);
        const contact = (p.contact ?? {}) as Record<string, unknown>;
        if (!recipient) recipient = str(input.channel === "WHATSAPP" ? (contact.whatsapp ?? contact.phone ?? "") : (contact.email ?? ""));
        if (typeof contact.locale === "string") recipientLocale = contact.locale;
      }
      if (!recipient) throw new PortalError("VALIDATION", "Destinataire requis (ou contact du tiers renseigné)");
      if (input.entryId) {
        const [e] = await tx`SELECT id FROM journal_entry WHERE id = ${input.entryId} AND tenant_id = ${ctx.tenantId}`;
        if (!e) throw new PortalError("NOT_FOUND", "Écriture introuvable");
      }
      const [row] = await tx`
        INSERT INTO missing_document_request (tenant_id, partner_id, entry_id, description, channel, recipient, requested_by)
        VALUES (${ctx.tenantId}, ${input.partnerId ?? null}, ${input.entryId ?? null}, ${description}, ${input.channel}, ${recipient}, ${ctx.userId})
        RETURNING *`;
      const [c] = await tx`SELECT name, locale FROM company WHERE id = ${ctx.tenantId}`;
      const brand = await this.brandFor(tx, ctx, str(c?.name ?? ""));
      return { row: row!, partnerName, brand, locale: resolveLocale({ recipient: recipientLocale, company: str(c?.locale ?? "") }) };
    });
    const request = mapMissingDocument(row);
    // L'e-mail reprend le modèle complet (motif de réception, mentions
    // légales) ; WhatsApp garde la phrase courte, qui est ce qu'on lit sur un
    // téléphone. Les deux disent la même chose.
    const mail =
      request.channel === "EMAIL"
        ? missingDocumentMail({
            ...(partnerName ? { partnerName } : {}),
            senderName: brand.sender,
            companyName: brand.company,
            description,
            locale,
            legalFooter: this.opts.legalFooter ?? legalFooterFromEnv(),
          })
        : null;
    try {
      await this.opts.notifier.send({
        channel: request.channel,
        to: request.recipient,
        subject: mail?.subject ?? (locale === "en" ? `${brand.sender}: missing document` : `${brand.sender} : pièce manquante`),
        body:
          mail?.text ??
          (locale === "en"
            ? `Hello${partnerName ? ` ${partnerName}` : ""}, ${brand.sender} needs the following document for ${brand.company}: ${description}. Please send it back in reply to this message.`
            : `Bonjour${partnerName ? ` ${partnerName}` : ""}, ${brand.sender} a besoin de la pièce suivante pour le dossier ${brand.company} : ${description}. Merci de la transmettre en réponse à ce message.`),
        ...(mail ? { html: mail.html } : {}),
        tenantId: ctx.tenantId,
        reference: `missing-document:${request.id}`,
      });
    } catch (e) {
      throw new PortalError("NOTIFY_FAILED", `Demande enregistrée mais envoi impossible : ${(e as Error).message}`, { requestId: request.id });
    }
    const [sent] = await withTenant(this.db, ctx, (tx) => tx`UPDATE missing_document_request SET sent_at = now() WHERE id = ${request.id} RETURNING *`);
    return mapMissingDocument(sent!);
  }

  async listMissingDocuments(ctx: TenantContext, filter: { open?: boolean } = {}): Promise<MissingDocumentRequest[]> {
    const rows = await withTenant(this.db, ctx, (tx) =>
      tx`SELECT * FROM missing_document_request WHERE tenant_id = ${ctx.tenantId}
         ${filter.open ? tx`AND received_document_id IS NULL` : tx``} ORDER BY created_at DESC`,
    );
    return rows.map(mapMissingDocument);
  }

  async markDocumentReceived(ctx: TenantContext, requestId: string, documentId: string): Promise<MissingDocumentRequest> {
    const [row] = await withTenant(this.db, ctx, async (tx) => {
      const [doc] = await tx`SELECT id FROM document WHERE id = ${documentId} AND tenant_id = ${ctx.tenantId}`;
      if (!doc) throw new PortalError("NOT_FOUND", "Pièce introuvable");
      return tx`UPDATE missing_document_request SET received_document_id = ${documentId}, received_at = now()
                WHERE id = ${requestId} AND tenant_id = ${ctx.tenantId} RETURNING *`;
    });
    if (!row) throw new PortalError("NOT_FOUND", "Demande introuvable");
    return mapMissingDocument(row);
  }

  // ---------------------------------------------------------------- dépôts

  /** Prépare un dépôt ; portail et format viennent du pack pays (filing) si non précisés. */
  async prepareFiling(
    ctx: TenantContext,
    input: { fiscalYearId: string; kind: FilingKind; portalName?: string; format?: FilingFormat; periodLabel?: string; fileDocumentId?: string },
  ): Promise<Filing> {
    const [row] = await withTenant(this.db, ctx, async (tx) => {
      const [fy] = await tx`SELECT id FROM fiscal_year WHERE id = ${input.fiscalYearId} AND tenant_id = ${ctx.tenantId}`;
      if (!fy) throw new PortalError("NOT_FOUND", "Exercice introuvable");
      const [c] = await tx`SELECT country_code FROM company WHERE id = ${ctx.tenantId}`;
      const pack = this.pack(str(c?.country_code ?? "").toLowerCase());
      // Un dépôt est, par définition, ce qui part à l'administration : si le
      // dossier a un pack pays, il doit être publié. Sans pack, rien n'a changé
      // (la validation « portail et format requis » ci-dessous tranche).
      if (pack) {
        try {
          assertPackPublished(pack, { artefact: `Dépôt ${input.kind}`, ...(this.env ? { env: this.env } : {}) });
        } catch (e) {
          if (e instanceof PackNotPublishedError) throw new PortalError("VALIDATION", e.message);
          throw e;
        }
      }
      const packFiling = pack?.filing.find((f) => f.id.toLowerCase() === input.kind.toLowerCase());
      const portalName = input.portalName ?? packFiling?.portal;
      const format = input.format ?? packFiling?.format;
      if (!portalName || !format) throw new PortalError("VALIDATION", "Portail et format requis (absents du pack pays)");
      if (input.fileDocumentId) await this.assertDocument(tx, ctx.tenantId, input.fileDocumentId);
      const [row] = await tx`
        INSERT INTO filing (tenant_id, fiscal_year_id, kind, portal_name, format, period_label, file_document_id, prepared_by)
        VALUES (${ctx.tenantId}, ${input.fiscalYearId}, ${input.kind}, ${portalName}, ${format}, ${input.periodLabel ?? null}, ${input.fileDocumentId ?? null}, ${ctx.userId})
        RETURNING *`;
      await audit(tx, { tenantId: ctx.tenantId, userId: ctx.userId, action: "FILING_PREPARED", entity: "filing", entityId: str(row!.id), after: mapFiling(row!) });
      return [row!];
    });
    return mapFiling(row!);
  }

  /** Marque le dépôt effectué ; avec un accusé, passe directement à ACKNOWLEDGED. */
  async markFiled(ctx: TenantContext, filingId: string, opts: { filedAt?: string; receiptDocumentId?: string; fileDocumentId?: string } = {}): Promise<Filing> {
    return withTenant(this.db, ctx, async (tx) => {
      const before = await this.filingFor(tx, ctx.tenantId, filingId);
      if (before.status !== "PREPARED") throw new PortalError("FILING_STATE", `Dépôt déjà ${before.status}`);
      if (opts.receiptDocumentId) await this.assertDocument(tx, ctx.tenantId, opts.receiptDocumentId);
      if (opts.fileDocumentId) await this.assertDocument(tx, ctx.tenantId, opts.fileDocumentId);
      const status: FilingStatus = opts.receiptDocumentId ? "ACKNOWLEDGED" : "FILED";
      const [row] = await tx`
        UPDATE filing SET status = ${status}, filed_at = ${opts.filedAt ?? tx`now()`},
          file_document_id = coalesce(${opts.fileDocumentId ?? null}, file_document_id),
          receipt_document_id = ${opts.receiptDocumentId ?? null},
          acknowledged_at = ${opts.receiptDocumentId ? tx`now()` : null}, updated_at = now()
        WHERE id = ${filingId} RETURNING *`;
      const after = mapFiling(row!);
      await audit(tx, { tenantId: ctx.tenantId, userId: ctx.userId, action: "FILING_FILED", entity: "filing", entityId: filingId, before, after });
      return after;
    });
  }

  /** Joint l'accusé de dépôt : le dépôt passe à ACKNOWLEDGED (préalable au verrouillage de l'exercice). */
  async attachReceipt(ctx: TenantContext, filingId: string, receiptDocumentId: string): Promise<Filing> {
    return withTenant(this.db, ctx, async (tx) => {
      const before = await this.filingFor(tx, ctx.tenantId, filingId);
      if (before.status === "PREPARED") throw new PortalError("FILING_STATE", "Le dépôt doit d'abord être marqué déposé");
      await this.assertDocument(tx, ctx.tenantId, receiptDocumentId);
      const [row] = await tx`
        UPDATE filing SET status = 'ACKNOWLEDGED', receipt_document_id = ${receiptDocumentId}, acknowledged_at = now(), updated_at = now()
        WHERE id = ${filingId} RETURNING *`;
      const after = mapFiling(row!);
      await audit(tx, { tenantId: ctx.tenantId, userId: ctx.userId, action: "FILING_ACKNOWLEDGED", entity: "filing", entityId: filingId, before, after });
      return after;
    });
  }

  async listFilings(ctx: TenantContext, filter: { fiscalYearId?: string; kind?: FilingKind } = {}): Promise<Filing[]> {
    const rows = await withTenant(this.db, ctx, (tx) =>
      tx`SELECT * FROM filing WHERE tenant_id = ${ctx.tenantId}
         ${filter.fiscalYearId ? tx`AND fiscal_year_id = ${filter.fiscalYearId}` : tx``}
         ${filter.kind ? tx`AND kind = ${filter.kind}` : tx``}
         ORDER BY created_at DESC`,
    );
    return rows.map(mapFiling);
  }

  // ---------------------------------------------------------------- facturation

  /**
   * Facture mensuelle d'une organisation = dossiers actifs × prix dégressif.
   * Dossier actif : existant à la fin du mois (aucune notion d'archivage pour l'instant).
   * Paliers et prix : surcharges de l'abonnement, sinon ceux du plan.
   */
  async computeInvoiceForOrganization(ctx: OrganizationContext, month: string): Promise<OrganizationInvoice> {
    if (!MONTH_RE.test(month)) throw new PortalError("VALIDATION", "Mois attendu au format AAAA-MM");
    return withTenant(this.db, orgCtx(ctx), async (tx) => {
      const sub = await this.subscription(tx, ctx.organizationId);
      const [count] = await tx`
        SELECT count(*)::int AS n FROM company
        WHERE organization_id = ${ctx.organizationId} AND created_at < (${month + "-01"}::date + interval '1 month')`;
      const n = int(count?.n);
      const invoice = computeDegressiveInvoice({
        dossiers: n,
        tiers: sub.degressive_tiers ?? sub.plan_tiers,
        pricePerDossier: str(sub.price_per_dossier ?? sub.plan_price),
        mode: str(sub.pricing_mode ?? sub.plan_mode) as PricingMode,
      });
      return { ...invoice, organizationId: ctx.organizationId, month, planCode: str(sub.plan_code), currency: str(sub.currency), activeDossiers: n };
    });
  }

  // ---------------------------------------------------------------- marque blanche

  async getWhiteLabel(ctx: OrganizationContext): Promise<WhiteLabelSettings> {
    return withTenant(this.db, orgCtx(ctx), async (tx) => WhiteLabelSchema.parse((await this.subscription(tx, ctx.organizationId)).white_label ?? {}));
  }

  async setWhiteLabel(ctx: OrganizationContext, settings: unknown): Promise<WhiteLabelSettings> {
    const parsed = WhiteLabelSchema.safeParse(settings);
    if (!parsed.success) throw new PortalError("VALIDATION", "Réglages de marque blanche invalides", parsed.error.issues);
    return withTenant(this.db, orgCtx(ctx), async (tx) => {
      await this.subscription(tx, ctx.organizationId);
      if (parsed.data.logoDocumentId) {
        // Le logo est une pièce d'un des dossiers de l'organisation.
        const [doc] = await tx`SELECT d.id FROM document d JOIN company c ON c.id = d.tenant_id WHERE d.id = ${parsed.data.logoDocumentId} AND c.organization_id = ${ctx.organizationId}`;
        if (!doc) throw new PortalError("NOT_FOUND", "Logo introuvable dans les dossiers de l'organisation");
      }
      const [row] = await tx`UPDATE organization_subscription SET white_label = ${tx.json(parsed.data)}, updated_at = now() WHERE organization_id = ${ctx.organizationId} RETURNING white_label`;
      return WhiteLabelSchema.parse(row!.white_label);
    });
  }

  // ---------------------------------------------------------------- usage et quotas

  /** Incrémente les compteurs du mois (défaut : mois courant) et renvoie l'état face aux quotas du plan. */
  async incrementUsage(ctx: TenantContext, delta: { month?: string; aiCalls?: number; documents?: number; whatsappMessages?: number }): Promise<UsageReport> {
    const month = delta.month ?? this.now().toISOString().slice(0, 7);
    if (!MONTH_RE.test(month)) throw new PortalError("VALIDATION", "Mois attendu au format AAAA-MM");
    for (const v of [delta.aiCalls, delta.documents, delta.whatsappMessages]) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new PortalError("VALIDATION", "Incrément entier positif attendu");
    }
    return withTenant(this.db, ctx, async (tx) => {
      const [row] = await tx`
        INSERT INTO usage_counter (tenant_id, month, ai_calls, documents, whatsapp_messages)
        VALUES (${ctx.tenantId}, ${month}, ${delta.aiCalls ?? 0}, ${delta.documents ?? 0}, ${delta.whatsappMessages ?? 0})
        ON CONFLICT (tenant_id, month) DO UPDATE SET
          ai_calls = usage_counter.ai_calls + EXCLUDED.ai_calls,
          documents = usage_counter.documents + EXCLUDED.documents,
          whatsapp_messages = usage_counter.whatsapp_messages + EXCLUDED.whatsapp_messages,
          updated_at = now()
        RETURNING *`;
      return this.report(tx, ctx, mapUsage(row!));
    });
  }

  async getUsage(ctx: TenantContext, month?: string): Promise<UsageReport> {
    const m = month ?? this.now().toISOString().slice(0, 7);
    if (!MONTH_RE.test(m)) throw new PortalError("VALIDATION", "Mois attendu au format AAAA-MM");
    return withTenant(this.db, ctx, async (tx) => {
      const [row] = await tx`SELECT * FROM usage_counter WHERE tenant_id = ${ctx.tenantId} AND month = ${m}`;
      return this.report(tx, ctx, row ? mapUsage(row) : { tenantId: ctx.tenantId, month: m, aiCalls: 0, documents: 0, whatsappMessages: 0 });
    });
  }

  // ---------------------------------------------------------------- internes

  private async report(tx: Sql, ctx: TenantContext, usage: UsageCounters): Promise<UsageReport> {
    const quotas = await this.quotasFor(tx, ctx);
    const over = (used: number, quota: number | null) => quota !== null && used > quota;
    return { ...usage, quotas, exceeded: { aiCalls: over(usage.aiCalls, quotas.aiCalls), documents: over(usage.documents, quotas.documents), whatsappMessages: over(usage.whatsappMessages, quotas.whatsappMessages) } };
  }

  /** Quotas du plan de l'organisation du dossier (lus par organization_of_company si le contexte n'a pas d'organisation). */
  private async quotasFor(tx: Sql, ctx: TenantContext): Promise<UsageQuotas> {
    const [row] = await tx`
      SELECT coalesce(p.quotas, '{}'::jsonb) AS quotas
      FROM company c
      LEFT JOIN organization_subscription s ON s.organization_id = c.organization_id
      LEFT JOIN subscription_plan p ON p.code = coalesce(s.plan_code, (SELECT o.plan FROM organization o WHERE o.id = c.organization_id))
      WHERE c.id = ${ctx.tenantId}`;
    return QuotasSchema.parse(row?.quotas ?? {});
  }

  /** Abonnement de l'organisation, créé au besoin sur le plan de l'organisation (ou TRIAL). */
  private async subscription(tx: Sql, organizationId: string): Promise<Row> {
    const select = () => tx`
      SELECT s.*, p.degressive_tiers AS plan_tiers, p.price_per_dossier AS plan_price, p.pricing_mode AS plan_mode, p.currency
      FROM organization_subscription s JOIN subscription_plan p ON p.code = s.plan_code
      WHERE s.organization_id = ${organizationId}`;
    let [row] = await select();
    if (!row) {
      await tx`
        INSERT INTO organization_subscription (organization_id, plan_code)
        SELECT o.id, coalesce((SELECT code FROM subscription_plan WHERE code = o.plan), 'TRIAL') FROM organization o WHERE o.id = ${organizationId}
        ON CONFLICT (organization_id) DO NOTHING`;
      [row] = await select();
    }
    if (!row) throw new PortalError("NOT_FOUND", "Organisation introuvable");
    return row;
  }

  private async brandFor(tx: Sql, ctx: TenantContext, companyName: string): Promise<{ sender: string; company: string }> {
    const [row] = await tx`
      SELECT s.white_label FROM company c JOIN organization_subscription s ON s.organization_id = c.organization_id WHERE c.id = ${ctx.tenantId}`;
    const wl = WhiteLabelSchema.safeParse(row?.white_label ?? {});
    const sender = (wl.success && (wl.data.senderName ?? wl.data.brandName)) || "ARCOMPT";
    return { sender, company: companyName };
  }

  private async filingFor(tx: Sql, tenantId: string, filingId: string): Promise<Filing> {
    const [row] = await tx`SELECT * FROM filing WHERE id = ${filingId} AND tenant_id = ${tenantId}`;
    if (!row) throw new PortalError("NOT_FOUND", "Dépôt introuvable");
    return mapFiling(row);
  }

  private async assertDocument(tx: Sql, tenantId: string, documentId: string): Promise<void> {
    const [doc] = await tx`SELECT id FROM document WHERE id = ${documentId} AND tenant_id = ${tenantId}`;
    if (!doc) throw new PortalError("NOT_FOUND", `Pièce ${documentId} introuvable`);
  }

  private pack(code: string): CountryPack | null {
    if (!code) return null;
    if (!this.packs.has(code)) {
      try {
        this.packs.set(code, this.loadPack(code));
      } catch {
        this.packs.set(code, null); // pack absent : pas d'échéances ni de valeurs par défaut de dépôt
      }
    }
    return this.packs.get(code) ?? null;
  }
}

function orgCtx(ctx: OrganizationContext): { tenantId: string; organizationId: string; userId?: string } {
  return { tenantId: "", organizationId: ctx.organizationId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
}

export function mapComment(r: Row): Comment {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), entityKind: str(r.entity_kind) as CommentEntityKind, entityId: str(r.entity_id), authorId: str(r.author_id),
    body: str(r.body), resolved: Boolean(r.resolved), resolvedBy: strOrNull(r.resolved_by), resolvedAt: isoOrNull(r.resolved_at), createdAt: iso(r.created_at),
  };
}

export function mapMissingDocument(r: Row): MissingDocumentRequest {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), partnerId: strOrNull(r.partner_id), entryId: strOrNull(r.entry_id), description: str(r.description),
    channel: str(r.channel) as MessageChannel, recipient: str(r.recipient), requestedBy: str(r.requested_by), sentAt: isoOrNull(r.sent_at),
    receivedDocumentId: strOrNull(r.received_document_id), receivedAt: isoOrNull(r.received_at), createdAt: iso(r.created_at),
  };
}

export function mapFiling(r: Row): Filing {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), fiscalYearId: str(r.fiscal_year_id), kind: str(r.kind) as FilingKind, portalName: str(r.portal_name),
    format: str(r.format) as FilingFormat, periodLabel: strOrNull(r.period_label), fileDocumentId: strOrNull(r.file_document_id),
    receiptDocumentId: strOrNull(r.receipt_document_id), status: str(r.status) as FilingStatus, preparedBy: str(r.prepared_by),
    filedAt: isoOrNull(r.filed_at), acknowledgedAt: isoOrNull(r.acknowledged_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function mapUsage(r: Row): UsageCounters {
  return { tenantId: str(r.tenant_id), month: str(r.month), aiCalls: int(r.ai_calls), documents: int(r.documents), whatsappMessages: int(r.whatsapp_messages) };
}
