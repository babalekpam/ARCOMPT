import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Ledger, PostgresStore } from "@arcompt/ledger";
import { seedFirmDemo, withTenant, type Db } from "@arcompt/db";
import { createTestDatabase } from "../../db/src/testing.js";
import { AccessService, MockNotifier, OrganizationService, PortalError, PortalService, type Organization, type TenantContext } from "./index.js";

/**
 * Tests d'intégration du portail : organisation, invitations, tableau de
 * bord, file de revue, commentaires, pièces, dépôts, facturation, marque
 * blanche, usage, accès administrateur et isolation entre organisations.
 * Les services tournent avec le rôle applicatif (RLS active).
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let appDb: Db;
let orgs: OrganizationService;
let portal: PortalService;
let access: AccessService;
let notifier: MockNotifier;
let firm: Organization;
let ownerId: string;
let companyA: string;
let companyB: string;
let fiscalYearA: string;
let partnerA: string;
let entryA: string;
let ctxA: TenantContext;
let ctxB: TenantContext;
let orgCtx: { organizationId: string; userId: string };

const FY = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
const NOW = new Date("2025-06-01T09:00:00Z");
/** Les dossiers sont créés « aujourd'hui » (created_at réel) : la facturation se teste sur le mois courant. */
const THIS_MONTH = new Date().toISOString().slice(0, 7);

async function documentIn(tenantId: string, uploadedBy: string): Promise<string> {
  const [d] = await withTenant(db, { tenantId }, (tx) =>
    tx`INSERT INTO document (tenant_id, storage_key, sha256, mime_type, size_bytes, uploaded_by)
       VALUES (${tenantId}, ${"k/" + randomUUID()}, ${randomUUID().replace(/-/g, "").repeat(2)}, 'application/pdf', 10, ${uploadedBy}) RETURNING id`,
  );
  return d!.id as string;
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await withTenant(db, { tenantId }, (tx) => tx`SELECT action FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY id`);
  return rows.map((r) => r.action as string);
}

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  appDb = env.appDb;
  notifier = new MockNotifier();
  orgs = new OrganizationService(appDb);
  // Le pack `ci` est en DRAFT : préparer un dépôt est refusé sans l'échappement
  // de pré-production. Le refus est éprouvé par pack-status.test.ts (fiscalité).
  portal = new PortalService(appDb, { notifier, now: () => NOW, env: { ALLOW_INSECURE_DRAFT_PACK_FILINGS: "1" } });
  access = new AccessService(appDb, notifier);

  firm = await orgs.createOrganization({ name: "Cabinet Test", kind: "FIRM" });
  const owner = await orgs.createUser({ organizationId: firm.id, email: "owner@cabinet.test", displayName: "Dirigeant" });
  ownerId = owner.id;
  orgCtx = { organizationId: firm.id, userId: ownerId };
  companyA = (await orgs.createCompany(firm.id, { name: "Alpha SARL", countryCode: "CI", fiscalYear: FY })).id;
  companyB = (await orgs.createCompany(firm.id, { name: "Bêta SA", countryCode: "CI", fiscalYear: FY })).id;
  await orgs.setRole(orgCtx, { companyId: companyA, userId: ownerId, role: "OWNER" });
  await orgs.setRole(orgCtx, { companyId: companyB, userId: ownerId, role: "OWNER" });
  ctxA = { tenantId: companyA, organizationId: firm.id, userId: ownerId };
  ctxB = { tenantId: companyB, organizationId: firm.id, userId: ownerId };

  const [fy] = await withTenant(db, { tenantId: companyA }, (tx) => tx`SELECT id FROM fiscal_year WHERE tenant_id = ${companyA}`);
  fiscalYearA = fy!.id as string;
  const [p] = await withTenant(db, { tenantId: companyA }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account, contact) VALUES (${companyA}, 'CUSTOMER', 'Client Alpha', '411', '{"whatsapp": "+2250700000001", "email": "alpha@client.test"}') RETURNING id`,
  );
  partnerA = p!.id as string;
  const ledger = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId: ownerId, organizationId: firm.id }), { baseCurrency: "XOF" });
  const actor = { userId: ownerId, tenantId: companyA };
  const posted = await ledger.post(actor, {
    journalCode: "VT", date: "2025-03-15", label: "Facture", source: "INVOICE",
    lines: [{ accountNumber: "411", debit: "118000", partnerId: partnerA }, { accountNumber: "706", credit: "100000" }, { accountNumber: "443", credit: "18000" }],
  });
  entryA = posted.id;
  await ledger.createDraft(actor, {
    journalCode: "AC", date: "2025-04-02", label: "Brouillon", source: "PURCHASE",
    lines: [{ accountNumber: "604", debit: "50000" }, { accountNumber: "521", credit: "50000" }],
  });
});

afterAll(async () => {
  await env?.drop();
});

run("organisation et dossiers", () => {
  it("un cabinet exige la MFA et ne peut pas la désactiver", async () => {
    expect(firm.kind).toBe("FIRM");
    expect(firm.mfaRequired).toBe(true);
    await expect(orgs.setMfaRequired(orgCtx, false)).rejects.toMatchObject({ code: "MFA_REQUIRED_FOR_FIRM" });
    const sme = await orgs.createOrganization({ name: "PME", kind: "COMPANY" });
    expect(sme.mfaRequired).toBe(false);
    expect((await orgs.setMfaRequired({ organizationId: sme.id }, true)).mfaRequired).toBe(true);
  });

  it("crée un dossier avec le plan, les journaux, l'exercice et les surcharges du pack", async () => {
    const companies = await orgs.listCompanies(orgCtx);
    expect(companies.map((c) => c.name)).toEqual(["Alpha SARL", "Bêta SA"]);
    expect(companies[0]!.packVersion).toBe("ci@2025.1");
    expect(companies[0]!.currency).toBe("XOF");
    const accounts = await withTenant(db, { tenantId: companyA }, (tx) => tx`SELECT number, label, postable FROM account WHERE tenant_id = ${companyA} AND number IN ('4471', '447', '4311', '431') ORDER BY number`);
    const byNumber = Object.fromEntries(accounts.map((a) => [a.number, a]));
    expect(byNumber["4471"]?.label).toMatch(/ITS/);
    expect(byNumber["4471"]?.postable).toBe(true);
    expect(byNumber["447"]?.postable).toBe(false);
    expect(byNumber["4311"]?.label).toMatch(/CNPS/);
    const [{ n }] = (await withTenant(db, { tenantId: companyA }, (tx) => tx`SELECT count(*)::int AS n FROM journal WHERE tenant_id = ${companyA}`)) as unknown as [{ n: number }];
    expect(n).toBe(7);
    await expect(orgs.createCompany(firm.id, { name: "X", countryCode: "ZZ", fiscalYear: FY })).rejects.toMatchObject({ code: "PACK_UNAVAILABLE" });
  });
});

run("invitations et membres", () => {
  let token: string;
  let invitedId: string;

  it("invite (jeton hashé, 7 jours max) puis accepte : app_user + company_member, audité", async () => {
    const { invitation, token: t } = await orgs.invite(orgCtx, { email: "Compta@Cabinet.test", role: "ACCOUNTANT", companyIds: [companyA, companyB], ttlHours: 10_000 });
    token = t;
    expect(invitation.email).toBe("compta@cabinet.test");
    expect(new Date(invitation.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 7 * 24 * 3600_000 + 60_000);
    const [stored] = await db`SELECT token_hash FROM invitation WHERE id = ${invitation.id}`;
    expect(stored!.token_hash).not.toBe(token);
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await orgs.listInvitations(orgCtx, { pending: true })).map((i) => i.id)).toContain(invitation.id);

    invitedId = randomUUID();
    const accepted = await orgs.acceptInvitation({ token, user: { id: invitedId, email: "compta@cabinet.test", displayName: "Compta" } });
    expect(accepted).toMatchObject({ userId: invitedId, organizationId: firm.id, role: "ACCOUNTANT", companyIds: [companyA, companyB] });
    const members = await orgs.listMembers(orgCtx, companyB);
    expect(members.find((m) => m.userId === invitedId)).toMatchObject({ role: "ACCOUNTANT", email: "compta@cabinet.test", companyName: "Bêta SA" });
    expect(await auditActions(companyB)).toContain("MEMBER_INVITATION_ACCEPTED");
    await expect(orgs.acceptInvitation({ token, user: { id: invitedId } })).rejects.toMatchObject({ code: "INVITATION_ACCEPTED" });
    await expect(orgs.acceptInvitation({ token: "inconnu", user: {} })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("refuse une invitation expirée ou vers un dossier étranger", async () => {
    const { invitation, token: t } = await orgs.invite(orgCtx, { email: "late@cabinet.test", role: "AUDITOR", companyIds: [companyA] });
    await db`UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE id = ${invitation.id}`;
    await expect(orgs.acceptInvitation({ token: t, user: {} })).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
    await expect(orgs.invite(orgCtx, { email: "x@y.z", role: "AUDITOR", companyIds: [randomUUID()] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("change un rôle, protège le dernier OWNER, retire un membre ; tout est dans audit_log", async () => {
    const m = await orgs.setRole(orgCtx, { companyId: companyA, userId: invitedId, role: "REVIEWER" });
    expect(m.role).toBe("REVIEWER");
    await expect(orgs.removeMember(orgCtx, { companyId: companyA, userId: ownerId })).rejects.toMatchObject({ code: "LAST_OWNER" });
    await expect(orgs.setRole(orgCtx, { companyId: companyA, userId: ownerId, role: "AUDITOR" })).rejects.toMatchObject({ code: "LAST_OWNER" });
    await orgs.removeMember(orgCtx, { companyId: companyA, userId: invitedId });
    expect((await orgs.listMembers(orgCtx, companyA)).some((x) => x.userId === invitedId)).toBe(false);
    const actions = await auditActions(companyA);
    expect(actions).toEqual(expect.arrayContaining(["MEMBER_ADDED", "MEMBER_INVITATION_ACCEPTED", "MEMBER_ROLE_SET", "MEMBER_REMOVED"]));
    await expect(orgs.removeMember(orgCtx, { companyId: companyA, userId: invitedId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("suspend les comptes inactifs depuis 90 jours et liste les droits à revalider", async () => {
    const dormant = await orgs.createUser({ organizationId: firm.id, email: "dormant@cabinet.test", displayName: "Dormant" });
    await db`UPDATE app_user SET created_at = now() - interval '100 days' WHERE id = ${dormant.id}`;
    await orgs.setRole(orgCtx, { companyId: companyB, userId: dormant.id, role: "CASHIER" });
    await orgs.touchActivity(ownerId);
    const suspended = await orgs.suspendInactiveAccounts(orgCtx);
    expect(suspended.map((u) => u.id)).toEqual([dormant.id]);
    expect(await auditActions(companyB)).toContain("ACCOUNT_SUSPENDED");
    expect(await orgs.suspendInactiveAccounts(orgCtx)).toEqual([]);
    const review = await orgs.entitlementReview(orgCtx);
    const item = review.find((r) => r.userId === dormant.id);
    expect(item?.reasons).toEqual(expect.arrayContaining(["SUSPENDED", "NEVER_ACTIVE"]));
    expect(review.find((r) => r.userId === ownerId && r.companyId === companyA)?.reasons).toEqual(["OWNER"]);
    expect((await orgs.reactivateUser(orgCtx, dormant.id)).id).toBe(dormant.id);
  });
});

run("tableau de bord et file de revue", () => {
  it("agrège par dossier : dernière écriture, brouillons, périodes, exercice, échéances", async () => {
    const rows = await portal.dashboard(orgCtx);
    expect(rows.map((r) => r.name)).toEqual(["Alpha SARL", "Bêta SA"]);
    const a = rows[0]!;
    // anomalies : les 12 périodes 2025 sont encore OPEN plus de 60 jours après leur fin ; le brouillon est récent (< 30 jours).
    expect(a).toMatchObject({ companyId: companyA, countryCode: "CI", lastEntryDate: "2025-03-15", draftCount: 1, validatedCount: 1, openPeriods: 12, anomalies: 12, unresolvedComments: 0, missingDocuments: 0 });
    expect(a.fiscalYear).toMatchObject({ code: "2025", status: "OPEN" });
    expect(a.pendingProposals === null || a.pendingProposals === 0).toBe(true);
    expect(a.workflowState).toBeNull();
    expect(a.nextDeadlines.map((d) => `${d.id}:${d.dueDate}`)).toEqual(expect.arrayContaining(["vat:2025-06-15", "dsf:2025-06-30"]));
    expect(rows[1]).toMatchObject({ companyId: companyB, lastEntryDate: null, draftCount: 0, validatedCount: 0 });
  });

  it("refuse le tableau de bord d'une autre organisation", async () => {
    const other = await orgs.createOrganization({ name: "Autre cabinet", kind: "FIRM" });
    await expect(withTenant(appDb, { tenantId: "", organizationId: other.id }, (tx) => tx`SELECT portal_dashboard(${firm.id})`)).rejects.toThrow(/non autorisée/);
  });

  it("file de revue : groupée par dossier, vide et sans erreur", async () => {
    const q = await portal.reviewQueue(orgCtx);
    expect(q.totalPending).toBe(0);
    if (q.available) {
      expect(q.companies.map((c) => c.name)).toEqual(["Alpha SARL", "Bêta SA"]);
      expect(q.companies.every((c) => c.pending === 0 && c.proposals.length === 0)).toBe(true);
    } else {
      expect(q.companies).toEqual([]);
    }
  });
});

run("commentaires, pièces manquantes, dépôts", () => {
  it("commentaires : création, liste par entité, résolution, isolation par dossier", async () => {
    const c = await portal.createComment(ctxA, { entityKind: "ENTRY", entityId: entryA, body: "Pièce justificative à joindre" });
    expect(c).toMatchObject({ entityKind: "ENTRY", entityId: entryA, authorId: ownerId, resolved: false });
    expect(await portal.listComments(ctxA, { entityKind: "ENTRY", entityId: entryA })).toHaveLength(1);
    expect(await portal.listComments(ctxB)).toEqual([]);
    expect((await portal.dashboard(orgCtx))[0]!.unresolvedComments).toBe(1);
    const resolved = await portal.resolveComment(ctxA, c.id);
    expect(resolved).toMatchObject({ resolved: true, resolvedBy: ownerId });
    expect(resolved.resolvedAt).not.toBeNull();
    await expect(portal.resolveComment(ctxB, c.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(portal.createComment(ctxA, { entityKind: "ENTRY", entityId: entryA, body: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("demande de pièce : ligne + message via le Notifier (contact du tiers), réception", async () => {
    notifier.sent.length = 0;
    const req = await portal.requestMissingDocument(ctxA, { partnerId: partnerA, entryId: entryA, description: "Facture FAC-2025-001 signée", channel: "WHATSAPP" });
    expect(req.recipient).toBe("+2250700000001");
    expect(req.sentAt).not.toBeNull();
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ channel: "WHATSAPP", to: "+2250700000001", tenantId: companyA, reference: `missing-document:${req.id}` });
    expect(notifier.sent[0]!.body).toContain("Client Alpha");
    expect(notifier.sent[0]!.body).toContain("Facture FAC-2025-001 signée");
    expect((await portal.dashboard(orgCtx))[0]!.missingDocuments).toBe(1);

    notifier.failNext = true;
    await expect(portal.requestMissingDocument(ctxA, { description: "Relevé", channel: "EMAIL", recipient: "x@y.test" })).rejects.toMatchObject({ code: "NOTIFY_FAILED" });
    const open = await portal.listMissingDocuments(ctxA, { open: true });
    expect(open).toHaveLength(2);
    expect(open.find((r) => r.description === "Relevé")?.sentAt).toBeNull();

    const docId = await documentIn(companyA, ownerId);
    const received = await portal.markDocumentReceived(ctxA, req.id, docId);
    expect(received.receivedDocumentId).toBe(docId);
    expect(await portal.listMissingDocuments(ctxA, { open: true })).toHaveLength(1);
    await expect(portal.markDocumentReceived(ctxB, req.id, docId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(portal.requestMissingDocument(ctxA, { description: "Sans destinataire", channel: "EMAIL" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("dépôts : préparé (valeurs du pack) → déposé → accusé joint", async () => {
    const f = await portal.prepareFiling(ctxA, { fiscalYearId: fiscalYearA, kind: "DSF" });
    expect(f).toMatchObject({ status: "PREPARED", portalName: expect.stringContaining("e-impôts"), format: "XLSX", filedAt: null });
    const receipt = await documentIn(companyA, ownerId);
    await expect(portal.attachReceipt(ctxA, f.id, receipt)).rejects.toMatchObject({ code: "FILING_STATE" });
    const filed = await portal.markFiled(ctxA, f.id);
    expect(filed.status).toBe("FILED");
    expect(filed.filedAt).not.toBeNull();
    await expect(portal.markFiled(ctxA, f.id)).rejects.toMatchObject({ code: "FILING_STATE" });
    const ack = await portal.attachReceipt(ctxA, f.id, receipt);
    expect(ack).toMatchObject({ status: "ACKNOWLEDGED", receiptDocumentId: receipt });
    expect(await portal.listFilings(ctxA, { fiscalYearId: fiscalYearA })).toHaveLength(1);
    expect(await portal.listFilings(ctxB)).toEqual([]);
    await expect(portal.prepareFiling(ctxA, { fiscalYearId: fiscalYearA, kind: "SOCIAL" })).rejects.toMatchObject({ code: "VALIDATION" });
    const social = await portal.prepareFiling(ctxA, { fiscalYearId: fiscalYearA, kind: "SOCIAL", portalName: "e-CNPS", format: "MANUAL", periodLabel: "2025-05" });
    expect(social.periodLabel).toBe("2025-05");
    expect(await auditActions(companyA)).toEqual(expect.arrayContaining(["FILING_PREPARED", "FILING_FILED", "FILING_ACKNOWLEDGED"]));
  });
});

run("facturation, marque blanche, usage", () => {
  it("facture = dossiers actifs × prix dégressif du plan", async () => {
    const trial = await portal.computeInvoiceForOrganization(orgCtx, THIS_MONTH);
    expect(trial).toMatchObject({ planCode: "TRIAL", activeDossiers: 2, total: "0.0000" });
    await db`UPDATE organization_subscription SET plan_code = 'CABINET' WHERE organization_id = ${firm.id}`;
    const cabinet = await portal.computeInvoiceForOrganization(orgCtx, THIS_MONTH);
    expect(cabinet).toMatchObject({ planCode: "CABINET", currency: "XOF", activeDossiers: 2, unitPrice: "12000.0000", total: "24000.0000" });
    expect((await portal.computeInvoiceForOrganization(orgCtx, "2000-01")).activeDossiers).toBe(0);
    await expect(portal.computeInvoiceForOrganization(orgCtx, "2025-13")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("marque blanche : lecture par défaut, écriture validée, utilisée comme expéditeur", async () => {
    expect(await portal.getWhiteLabel(orgCtx)).toEqual({ brandName: null, logoDocumentId: null, colours: { primary: null, accent: null }, senderName: null });
    const set = await portal.setWhiteLabel(orgCtx, { brandName: "Cabinet Test & Associés", colours: { primary: "#112233" }, senderName: "Cabinet Test" });
    expect(set).toMatchObject({ brandName: "Cabinet Test & Associés", colours: { primary: "#112233", accent: null }, senderName: "Cabinet Test" });
    expect(await portal.getWhiteLabel(orgCtx)).toEqual(set);
    await expect(portal.setWhiteLabel(orgCtx, { colours: { primary: "rouge" } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(portal.setWhiteLabel(orgCtx, { logoDocumentId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    notifier.sent.length = 0;
    await portal.requestMissingDocument(ctxA, { description: "Bon de commande", channel: "EMAIL", recipient: "client@alpha.test" });
    expect(notifier.sent[0]!.body).toContain("Cabinet Test a besoin");
  });

  it("compteurs d'usage mensuels et quotas du plan", async () => {
    await db`UPDATE organization_subscription SET plan_code = 'TRIAL' WHERE organization_id = ${firm.id}`;
    await portal.incrementUsage(ctxA, { month: "2025-06", aiCalls: 3, documents: 1 });
    const u = await portal.incrementUsage(ctxA, { month: "2025-06", aiCalls: 3 });
    expect(u).toMatchObject({ month: "2025-06", aiCalls: 6, documents: 1, whatsappMessages: 0, quotas: { aiCalls: 50 }, exceeded: { aiCalls: false } });
    const over = await portal.incrementUsage(ctxA, { month: "2025-06", aiCalls: 100 });
    expect(over.exceeded.aiCalls).toBe(true);
    expect((await portal.getUsage(ctxA, "2025-06")).aiCalls).toBe(106);
    expect((await portal.getUsage(ctxB, "2025-06")).aiCalls).toBe(0);
    expect((await portal.getUsage(ctxA)).month).toBe("2025-06");
    await expect(portal.incrementUsage(ctxA, { aiCalls: -1 })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

run("accès administrateur et accès d'urgence", () => {
  const admin1 = randomUUID();
  const admin2 = randomUUID();

  it("journalise l'accès et prévient les dirigeants du dossier", async () => {
    notifier.sent.length = 0;
    const { record, notified } = await access.recordAdminAccess(companyA, admin1, "Reconstruction d'un index corrompu");
    expect(notified).toEqual([ownerId]);
    expect(record).toMatchObject({ adminUserId: admin1, notifiedCount: 1, breakGlassRequestId: null });
    expect(record.notifiedAt).not.toBeNull();
    expect(notifier.sent[0]).toMatchObject({ channel: "EMAIL", to: "owner@cabinet.test", tenantId: companyA, reference: `admin-access:${record.id}` });
    expect(notifier.sent[0]!.body).toContain("un technicien a accédé à votre dossier");
    expect(notifier.sent[0]!.subject).toBe("Accès technique à votre dossier Alpha SARL");
    // Modèle complet : motif de réception et mentions légales, version HTML incluse.
    expect(notifier.sent[0]!.body).toContain("Vous recevez ce message");
    expect(notifier.sent[0]!.html).toContain("<p>");
    expect((await access.listAdminAccess(companyA)).map((r) => r.id)).toContain(record.id);
    expect(await access.listAdminAccess(companyB)).toEqual([]);
    expect(await auditActions(companyA)).toContain("ADMIN_ACCESS");
    await expect(withTenant(appDb, { tenantId: companyA }, (tx) => tx`UPDATE admin_access_log SET reason = 'autre' WHERE id = ${record.id}`)).rejects.toThrow(/interdit/);
    await expect(withTenant(appDb, { tenantId: companyA }, (tx) => tx`DELETE FROM admin_access_log WHERE id = ${record.id}`)).rejects.toThrow();
    await expect(access.recordAdminAccess(companyA, admin1, "x")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("break-glass : ≤ 4 h, approuvé par un second administrateur, intégralement audité", async () => {
    await expect(access.requestBreakGlass({ tenantId: companyA, requesterId: admin1, reason: "Incident production", durationHours: 5 })).rejects.toMatchObject({ code: "VALIDATION" });
    const req = await access.requestBreakGlass({ tenantId: companyA, requesterId: admin1, reason: "Incident production", durationHours: 2 });
    expect(req.status).toBe("REQUESTED");
    expect(new Date(req.expiresAt).getTime() - new Date(req.requestedAt).getTime()).toBe(2 * 3600_000);
    await expect(access.approveBreakGlass({ tenantId: companyA, requestId: req.id, approverId: admin1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(access.recordAdminAccess(companyA, admin1, "Accès urgence", { breakGlassRequestId: req.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const approved = await access.approveBreakGlass({ tenantId: companyA, requestId: req.id, approverId: admin2 });
    expect(approved).toMatchObject({ status: "APPROVED", approverId: admin2, active: true });
    await expect(access.approveBreakGlass({ tenantId: companyA, requestId: req.id, approverId: admin2 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(access.recordAdminAccess(companyA, admin2, "Accès urgence", { breakGlassRequestId: req.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    notifier.sent.length = 0;
    const { record } = await access.recordAdminAccess(companyA, admin1, "Accès urgence", { breakGlassRequestId: req.id });
    expect(record.breakGlassRequestId).toBe(req.id);
    // L'accès d'urgence a son propre message : il dit l'approbation par un
    // second administrateur et la fin de l'accès.
    expect(notifier.sent[0]!.subject).toBe("Accès d'urgence à votre dossier Alpha SARL");
    expect(notifier.sent[0]!.body).toContain("approuvé par un second");
    expect((await access.listBreakGlass(companyA, { activeOnly: true })).map((b) => b.id)).toEqual([req.id]);
    const revoked = await access.revokeBreakGlass({ tenantId: companyA, requestId: req.id, userId: admin2 });
    expect(revoked).toMatchObject({ status: "REVOKED", active: false });
    await expect(access.recordAdminAccess(companyA, admin1, "Accès urgence", { breakGlassRequestId: req.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(withTenant(appDb, { tenantId: companyA }, (tx) => tx`UPDATE break_glass_request SET approver_id = requester_id WHERE id = ${req.id}`)).rejects.toThrow();
    expect(await auditActions(companyA)).toEqual(expect.arrayContaining(["BREAK_GLASS_REQUESTED", "BREAK_GLASS_APPROVED", "BREAK_GLASS_REVOKED"]));
    expect(await access.listBreakGlass(companyB)).toEqual([]);
  });
});

run("isolation entre organisations (RLS)", () => {
  it("un utilisateur d'une autre organisation ne voit rien", async () => {
    const other = await orgs.createOrganization({ name: "Cabinet Étranger", kind: "FIRM" });
    const stranger = await orgs.createUser({ organizationId: other.id, email: "s@etranger.test", displayName: "S" });
    const ctx = { organizationId: other.id, userId: stranger.id };
    expect(await portal.dashboard(ctx)).toEqual([]);
    expect(await orgs.listCompanies(ctx)).toEqual([]);
    expect(await orgs.listMembers(ctx)).toEqual([]);
    expect(await orgs.listInvitations(ctx)).toEqual([]);
    expect(await orgs.entitlementReview(ctx)).toEqual([]);
    expect((await portal.reviewQueue(ctx)).companies).toEqual([]);
    await expect(orgs.setRole(ctx, { companyId: companyA, userId: stranger.id, role: "OWNER" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(orgs.invite(ctx, { email: "x@y.z", role: "AUDITOR", companyIds: [companyA] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Même en forgeant un contexte tenant, les tables de niveau organisation restent invisibles.
    const rows = await withTenant(appDb, { tenantId: companyA, organizationId: other.id, userId: stranger.id }, (tx) => tx`SELECT id FROM invitation`);
    expect(rows).toEqual([]);
    expect(await portal.getWhiteLabel(ctx)).toMatchObject({ brandName: null });
    expect((await portal.computeInvoiceForOrganization(ctx, THIS_MONTH)).activeDossiers).toBe(0);
  });
});

run("file de revue sans module documents", () => {
  it("reste vide et sans erreur si la table ai_proposal est absente", async () => {
    await db.unsafe("DROP TABLE IF EXISTS ai_proposal CASCADE");
    const q = await portal.reviewQueue(orgCtx);
    expect(q).toEqual({ available: false, totalPending: 0, companies: [] });
    expect((await portal.dashboard(orgCtx))[0]!.pendingProposals).toBeNull();
  });
});

run("seedFirmDemo", () => {
  it("crée un cabinet de démonstration exploitable par le portail", async () => {
    const seeded = await seedFirmDemo(db);
    expect(seeded.companyIds).toHaveLength(3);
    const ctx = { organizationId: seeded.organizationId, userId: seeded.users.owner };
    const rows = await portal.dashboard(ctx);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.draftCount === 1 && r.validatedCount === 2 && r.lastEntryDate === "2025-02-10")).toBe(true);
    const members = await orgs.listMembers(ctx);
    expect(members.filter((m) => m.role === "OWNER")).toHaveLength(3);
    expect(members.filter((m) => m.role === "REVIEWER")).toHaveLength(3);
    expect((await orgs.getOrganization(ctx)).mfaRequired).toBe(true);
    expect((await portal.computeInvoiceForOrganization(ctx, THIS_MONTH)).total).toBe("36000.0000");
  });
});

it("PortalError expose un statut HTTP", () => {
  expect(new PortalError("NOT_FOUND", "x").httpStatus).toBe(404);
  expect(new PortalError("LAST_OWNER", "x").httpStatus).toBe(409);
  expect(new PortalError("VALIDATION", "x").httpStatus).toBe(400);
});
