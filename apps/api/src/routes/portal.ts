// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTenant } from "@arcompt/db";
import {
  AccessService,
  MEMBER_ROLES,
  OrganizationService,
  PortalError,
  PortalService,
  WhiteLabelSchema,
  type MemberRole,
  type Notifier,
} from "@arcompt/portal";
import { invitationMail, legalFooterFromEnv, resolveLocale } from "@arcompt/mailer";
import { createProviderFromEnv } from "@arcompt/whatsapp";
import { requireRole, type AuthContext } from "../auth.js";
import type { AppDeps } from "../app.js";
import { createMailer, createNotifier } from "../notifications.js";
import { log } from "../telemetry.js";

/**
 * Portail cabinets : organisation, dossiers, invitations, membres, tableau de
 * bord multi-dossiers, file de revue, facturation, marque blanche, puis, au
 * niveau du dossier courant : commentaires, pièces manquantes, dépôts, usage,
 * journal des accès administrateur.
 *
 * L'organisation vient du jeton (organizationId) ; en mode dev, où le jeton
 * n'en porte pas, elle est résolue depuis le dossier courant par la fonction
 * SECURITY DEFINER organization_of_company(tenant).
 *
 * Le Notifier (e-mail / WhatsApp) est construit depuis l'environnement, sauf
 * injection explicite (tests). Il ne peut plus être muet : un canal non
 * configuré lève, et le service appelant répond NOTIFY_FAILED sans marquer la
 * demande comme envoyée. L'accès d'urgence (break-glass) et recordAdminAccess()
 * sont des opérations d'exploitation (AccessService), exposées ici en lecture
 * seule pour les dossiers.
 */
export interface PortalRouteOptions {
  notifier?: Notifier;
  /** Base des liens envoyés aux invités ; défaut : `APP_URL`. */
  appUrl?: string;
  /** Mentions légales en pied des e-mails ; défaut : `MAIL_LEGAL_FOOTER`. */
  legalFooter?: string;
}

/** Page du portail web qui porte le formulaire « Accepter une invitation ». */
export const INVITATION_ACCEPT_PATH = "/invite";

const uuid = z.string().uuid();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const role = z.enum(MEMBER_ROLES as [MemberRole, ...MemberRole[]]);

const CreateOrganizationSchema = z.object({ name: z.string().min(1).max(200), kind: z.enum(["FIRM", "COMPANY", "GROUP"]), plan: z.string().max(40).optional() });
const CreateCompanySchema = z.object({
  name: z.string().min(1).max(200),
  countryCode: z.string().length(2),
  packCode: z.string().min(2).max(8).optional(),
  currency: z.string().length(3).optional(),
  accountingSystem: z.enum(["NORMAL", "SMT"]).optional(),
  taxRegime: z.string().max(60).optional(),
  taxIds: z.record(z.string()).optional(),
  fiscalYear: z.object({ code: z.string().min(1).max(20), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
});
// `locale` : l'invité n'a pas encore de compte, donc pas de `app_user.locale`.
// Personne d'autre que celui qui invite ne sait dans quelle langue écrire ;
// absent, on retombe sur la langue du premier dossier de l'invitation.
const InviteSchema = z.object({ email: z.string().email(), role, companyIds: z.array(uuid).min(1), ttlHours: z.number().int().positive().optional(), locale: z.enum(["fr", "en"]).optional() });
const AcceptSchema = z.object({ token: z.string().min(16), displayName: z.string().max(120).optional() }).strict();
const SetRoleSchema = z.object({ role });
const CommentSchema = z.object({ entityKind: z.enum(["ENTRY", "DOCUMENT", "PROPOSAL", "PERIOD", "FISCAL_YEAR"]), entityId: uuid, body: z.string().min(1).max(4000) });
const CommentQuery = z.object({ entityKind: z.enum(["ENTRY", "DOCUMENT", "PROPOSAL", "PERIOD", "FISCAL_YEAR"]).optional(), entityId: uuid.optional(), resolved: z.enum(["true", "false"]).optional() });
const MissingDocSchema = z.object({ partnerId: uuid.optional(), entryId: uuid.optional(), description: z.string().min(1).max(2000), channel: z.enum(["WHATSAPP", "EMAIL"]), recipient: z.string().min(3).max(200).optional() });
const ReceivedSchema = z.object({ documentId: uuid });
const PrepareFilingSchema = z.object({
  fiscalYearId: uuid,
  kind: z.enum(["DSF", "VAT", "SOCIAL"]),
  portalName: z.string().min(1).max(200).optional(),
  format: z.enum(["XLSX", "XML", "PDF", "CSV", "MANUAL"]).optional(),
  periodLabel: z.string().max(20).optional(),
  fileDocumentId: uuid.optional(),
});
const MarkFiledSchema = z.object({ filedAt: z.string().datetime().optional(), receiptDocumentId: uuid.optional(), fileDocumentId: uuid.optional() });
const ReceiptSchema = z.object({ receiptDocumentId: uuid });
const UsageIncrementSchema = z.object({ month: month.optional(), aiCalls: z.number().int().nonnegative().optional(), documents: z.number().int().nonnegative().optional(), whatsappMessages: z.number().int().nonnegative().optional() });

/** Type sans les `| undefined` des propriétés optionnelles (exactOptionalPropertyTypes). */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };
/** Retire les clés undefined : zod garde des `| undefined` que les entrées des services n'admettent pas. */
const strip = <T extends object>(o: T): Defined<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;

export function portalRoutes(deps: AppDeps, opts: PortalRouteOptions = {}) {
  const r = new Hono();
  const db = deps.db;
  if (!db) {
    r.all("*", (c) => c.json({ error: { code: "UNAVAILABLE", message: "Portail indisponible : base de données non configurée" } }, 503));
    return r;
  }
  const legalFooter = opts.legalFooter ?? legalFooterFromEnv();
  const appUrl = (opts.appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  // Sans injection, on prend les canaux réels de l'environnement. En
  // production, `createMailerFromEnv` refuse de rendre un expéditeur muet sans
  // ALLOW_INSECURE_MAIL=1 : le portail ne peut plus enregistrer des envois qui
  // n'ont pas eu lieu.
  const notifier: Notifier =
    opts.notifier ??
    createNotifier({
      mailer: createMailer({ ...(deps.quiet ? { quiet: true } : {}) }),
      whatsapp: createProviderFromEnv(),
      legalFooter,
    });
  const orgs = new OrganizationService(db);
  const portal = new PortalService(db, { notifier, legalFooter });
  const access = new AccessService(db, notifier, {
    legalFooter,
    warn: (message: string) => {
      if (!deps.quiet) log("warn", "portal.notify_failed", { detail: message });
    },
  });

  const orgRole = requireRole("OWNER", "ACCOUNTANT", "REVIEWER");
  const ownerRole = requireRole("OWNER");
  const writeRole = requireRole("OWNER", "ACCOUNTANT", "REVIEWER");
  const captureRole = requireRole("OWNER", "ACCOUNTANT", "REVIEWER", "CASHIER");

  /** Organisation du contexte : jeton, sinon dossier courant (mode dev). */
  async function organizationOf(auth: AuthContext): Promise<string | null> {
    if (auth.organizationId) return auth.organizationId;
    const [row] = await withTenant(db!, { tenantId: auth.tenantId }, (tx) => tx`SELECT organization_of_company(${auth.tenantId}) AS id`);
    return row?.id ? String(row.id) : null;
  }

  /** Traduit PortalError en réponse JSON ; le reste remonte à app.onError. */
  const h = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof PortalError) return c.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, e.httpStatus);
      throw e;
    }
  };

  const orgCtx = async (c: Context) => {
    const auth = c.get("auth");
    const organizationId = await organizationOf(auth);
    if (!organizationId) throw new PortalError("FORBIDDEN", "Aucune organisation pour ce dossier");
    return { organizationId, userId: auth.userId };
  };
  const tenantCtx = (c: Context) => {
    const auth = c.get("auth");
    return { tenantId: auth.tenantId, userId: auth.userId, ...(auth.organizationId ? { organizationId: auth.organizationId } : {}) };
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) throw new PortalError("VALIDATION", "Corps invalide", parsed.error.issues);
    return parsed.data;
  };
  const query = <T>(c: Context, schema: z.ZodType<T>): T => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) throw new PortalError("VALIDATION", "Paramètres invalides", parsed.error.issues);
    return parsed.data;
  };

  // ------------------------------------------------------------ organisation
  r.get("/org", orgRole, h(async (c) => c.json(await orgs.getOrganization(await orgCtx(c)))));
  r.post("/org", ownerRole, h(async (c) => c.json(await orgs.createOrganization(strip(await body(c, CreateOrganizationSchema))), 201)));
  r.put("/org/mfa", ownerRole, h(async (c) => c.json(await orgs.setMfaRequired(await orgCtx(c), (await body(c, z.object({ required: z.boolean() }))).required))));

  r.get("/org/companies", orgRole, h(async (c) => c.json(await orgs.listCompanies(await orgCtx(c)))));
  r.post("/org/companies", writeRole, h(async (c) => {
    const ctx = await orgCtx(c);
    return c.json(await orgs.createCompany(ctx.organizationId, strip(await body(c, CreateCompanySchema))), 201);
  }));

  r.get("/org/invitations", orgRole, h(async (c) => c.json(await orgs.listInvitations(await orgCtx(c), { pending: c.req.query("pending") === "true" }))));
  /**
   * Crée l'invitation PUIS l'envoie à l'invité.
   *
   * Le jeton en clair n'existe qu'ici : jusqu'à présent, il n'apparaissait que
   * dans cette réponse, à charge pour l'inviteur de le recopier et de le
   * transmettre par ses propres moyens. Il part maintenant par e-mail.
   *
   * L'invitation reste créée si l'envoi échoue — le jeton est dans la réponse,
   * l'inviteur peut encore le transmettre — mais la réponse dit franchement
   * que rien n'est parti, et pourquoi.
   */
  r.post("/org/invitations", writeRole, h(async (c) => {
    const ctx = await orgCtx(c);
    const { locale: requestedLocale, ...input } = strip(await body(c, InviteSchema));
    const created = await orgs.invite(ctx, input);
    const [invitedCompany] = deps.db
      ? await withTenant(deps.db, { tenantId: input.companyIds[0]!, userId: ctx.userId, organizationId: ctx.organizationId }, (tx) => tx`SELECT locale FROM company WHERE id = ${input.companyIds[0]!}`)
      : [];
    const organization = await orgs.getOrganization(ctx).catch(() => null);
    const delivery: { sent: boolean; channel: "EMAIL"; error?: string } = { sent: false, channel: "EMAIL" };
    try {
      const mail = invitationMail({
        organizationName: organization?.name ?? "Votre organisation",
        role: created.invitation.role,
        companyCount: created.invitation.companyIds.length,
        // Le code voyage dans le FRAGMENT, jamais dans la requête : un fragment
        // n'est pas transmis au serveur, il n'apparaît donc ni dans les journaux
        // d'accès ni dans l'en-tête Referer vers un tiers. Le formulaire le
        // récupère côté navigateur puis l'efface de la barre d'adresse. Le code
        // reste écrit plus bas dans le message, pour qui ouvre le lien ailleurs.
        acceptUrl: `${appUrl}${INVITATION_ACCEPT_PATH}#token=${encodeURIComponent(created.token)}`,
        token: created.token,
        expiresAt: created.invitation.expiresAt,
        locale: resolveLocale({ requested: requestedLocale, company: invitedCompany ? String(invitedCompany.locale) : null, user: c.get("auth").locale }),
        legalFooter,
      });
      await notifier.send({
        channel: "EMAIL",
        to: created.invitation.email,
        subject: mail.subject,
        body: mail.text,
        html: mail.html,
        tenantId: input.companyIds[0]!,
        reference: `invitation:${created.invitation.id}`,
      });
      delivery.sent = true;
    } catch (e) {
      delivery.error = (e as Error).message;
      if (!deps.quiet) log("warn", "portal.invitation.not_sent", { invitationId: created.invitation.id, detail: delivery.error });
    }
    return c.json({ ...created, delivery }, 201);
  }));
  // Acceptation : utilisateur connecté + jeton ; aucun rôle requis (il n'est pas encore membre).
  r.post("/org/invitations/accept", h(async (c) => {
    const auth = c.get("auth");
    const input = await body(c, AcceptSchema);
    if (!auth.invitationIdentity) throw new PortalError("FORBIDDEN", "Identité Clerk vérifiée requise");
    const user = strip({
      ...(UUID_RE.test(auth.userId) ? { id: auth.userId } : {}),
      email: auth.invitationIdentity.email,
      keycloakSub: auth.invitationIdentity.sub,
      secondFactor: auth.invitationIdentity.secondFactor,
      displayName: input.displayName,
    });
    return c.json(await orgs.acceptInvitation({ token: input.token, user }));
  }));

  // Only the resolved signed-in member's reference; never accept a Clerk ID
  // or a user ID supplied by the browser for this lookup.
  r.get("/org/members/self-reference", h(async (c) => {
    const auth = c.get("auth");
    if (!auth.tenantId) return c.json({ reference: null });
    const member = (await orgs.listMembers(await orgCtx(c), auth.tenantId)).find((m) => m.userId === auth.userId);
    if (!member) throw new PortalError("FORBIDDEN", "Aucun membre dans ce dossier");
    return c.json({ reference: member.reference });
  }));
  r.get("/org/members", orgRole, h(async (c) => {
    const q = query(c, z.object({ companyId: uuid.optional() }));
    return c.json(await orgs.listMembers(await orgCtx(c), q.companyId));
  }));
  r.put("/org/members/:companyId/:userId", ownerRole, h(async (c) => {
    const { role: newRole } = await body(c, SetRoleSchema);
    return c.json(await orgs.setRole(await orgCtx(c), { companyId: uuid.parse(c.req.param("companyId")), userId: uuid.parse(c.req.param("userId")), role: newRole }));
  }));
  r.delete("/org/members/:companyId/:userId", ownerRole, h(async (c) => {
    await orgs.removeMember(await orgCtx(c), { companyId: uuid.parse(c.req.param("companyId")), userId: uuid.parse(c.req.param("userId")) });
    return c.body(null, 204);
  }));
  r.post("/org/members/suspend-inactive", ownerRole, h(async (c) => {
    const { days } = await body(c, z.object({ days: z.number().int().positive().optional() }));
    return c.json(await orgs.suspendInactiveAccounts(await orgCtx(c), days));
  }));
  r.get("/org/entitlement-review", ownerRole, h(async (c) => c.json(await orgs.entitlementReview(await orgCtx(c)))));
  r.get("/org/entitlements", orgRole, h(async (c) => c.json(await orgs.entitlements(await orgCtx(c)))));

  r.get("/org/dashboard", orgRole, h(async (c) => c.json(await portal.dashboard(await orgCtx(c)))));
  r.get("/org/review-queue", orgRole, h(async (c) => c.json(await portal.reviewQueue(await orgCtx(c)))));
  r.get("/org/billing", orgRole, h(async (c) => {
    const q = query(c, z.object({ month }));
    return c.json(await portal.computeInvoiceForOrganization(await orgCtx(c), q.month));
  }));
  r.get("/org/white-label", orgRole, h(async (c) => c.json(await portal.getWhiteLabel(await orgCtx(c)))));
  r.put("/org/white-label", ownerRole, h(async (c) => c.json(await portal.setWhiteLabel(await orgCtx(c), await body(c, WhiteLabelSchema)))));

  // ------------------------------------------------------------ dossier courant
  r.get("/comments", h(async (c) => {
    const q = query(c, CommentQuery);
    return c.json(await portal.listComments(tenantCtx(c), strip({ entityKind: q.entityKind, entityId: q.entityId, resolved: q.resolved === undefined ? undefined : q.resolved === "true" })));
  }));
  r.post("/comments", captureRole, h(async (c) => c.json(await portal.createComment(tenantCtx(c), await body(c, CommentSchema)), 201)));
  r.post("/comments/:id/resolve", writeRole, h(async (c) => {
    const { resolved } = await body(c, z.object({ resolved: z.boolean().default(true) }));
    return c.json(await portal.resolveComment(tenantCtx(c), uuid.parse(c.req.param("id")), resolved));
  }));

  r.get("/missing-documents", h(async (c) => c.json(await portal.listMissingDocuments(tenantCtx(c), { open: c.req.query("open") === "true" }))));
  r.post("/missing-documents", captureRole, h(async (c) => c.json(await portal.requestMissingDocument(tenantCtx(c), strip(await body(c, MissingDocSchema))), 201)));
  r.post("/missing-documents/:id/received", captureRole, h(async (c) => {
    const { documentId } = await body(c, ReceivedSchema);
    return c.json(await portal.markDocumentReceived(tenantCtx(c), uuid.parse(c.req.param("id")), documentId));
  }));

  r.get("/filings", h(async (c) => {
    const q = query(c, z.object({ fiscalYearId: uuid.optional(), kind: z.enum(["DSF", "VAT", "SOCIAL"]).optional() }));
    return c.json(await portal.listFilings(tenantCtx(c), strip(q)));
  }));
  r.post("/filings/prepare", writeRole, h(async (c) => c.json(await portal.prepareFiling(tenantCtx(c), strip(await body(c, PrepareFilingSchema))), 201)));
  r.post("/filings/:id/mark-filed", writeRole, h(async (c) => c.json(await portal.markFiled(tenantCtx(c), uuid.parse(c.req.param("id")), strip(await body(c, MarkFiledSchema))))));
  r.post("/filings/:id/attach-receipt", writeRole, h(async (c) => {
    const { receiptDocumentId } = await body(c, ReceiptSchema);
    return c.json(await portal.attachReceipt(tenantCtx(c), uuid.parse(c.req.param("id")), receiptDocumentId));
  }));

  r.get("/usage", h(async (c) => {
    const q = query(c, z.object({ month: month.optional() }));
    return c.json(await portal.getUsage(tenantCtx(c), q.month));
  }));
  r.post("/usage", writeRole, h(async (c) => c.json(await portal.incrementUsage(tenantCtx(c), strip(await body(c, UsageIncrementSchema))))));

  // Journal des accès administrateur et accès d'urgence : lecture seule pour le dossier.
  r.get("/admin-access", h(async (c) => c.json(await access.listAdminAccess(c.get("auth").tenantId))));
  r.get("/break-glass", h(async (c) => c.json(await access.listBreakGlass(c.get("auth").tenantId, { activeOnly: c.req.query("active") === "true" }))));

  return r;
}
