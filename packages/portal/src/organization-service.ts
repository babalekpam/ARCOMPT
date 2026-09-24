// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { decryptTaxIds, encryptTaxIds, seedCompany, tenantCipherIn, withTenant, type Db } from "@arcompt/db";
import { loadPack as defaultLoadPack, type CountryPack } from "@arcompt/country-packs";
import { PortalError } from "./errors.js";
import { audit, iso, isoOrNull, str, strOrNull, type Row } from "./sql.js";
import { generateInvitationToken, hashInvitationToken } from "./tokens.js";
import {
  MEMBER_ROLES,
  type AppUser,
  type CompanyMember,
  type CompanySummary,
  type Invitation,
  type MemberRole,
  type Organization,
  type OrganizationContext,
  type OrganizationKind,
} from "./types.js";

/** Durée de vie maximale d'une invitation (SECURITY.md §4 : « invitation seule et limitée dans le temps »). */
export const INVITATION_MAX_TTL_HOURS = 7 * 24;
/** Suspension après 90 jours d'inactivité. */
export const INACTIVITY_SUSPENSION_DAYS = 90;

export interface CreateOrganizationInput {
  name: string;
  kind: OrganizationKind;
  plan?: string;
}

export interface CreateUserInput {
  organizationId: string;
  email: string;
  displayName: string;
  keycloakSub?: string;
  locale?: string;
  /** Identifiant imposé (sub Keycloak au format uuid) pour que le jeton et app_user coïncident. */
  id?: string;
}

export interface CreateCompanyInput {
  name: string;
  /** Code ISO du pays (CI, SN…). Le pack chargé est `packCode ?? countryCode.toLowerCase()`. */
  countryCode: string;
  packCode?: string;
  currency?: string;
  accountingSystem?: "NORMAL" | "SMT";
  taxRegime?: string;
  taxIds?: Record<string, string>;
  fiscalYear: { code: string; startDate: string; endDate: string };
}

export interface InviteInput {
  email: string;
  role: MemberRole;
  companyIds: string[];
  ttlHours?: number;
}

export interface AcceptInvitationInput {
  token: string;
  /** Utilisateur connecté (issu du jeton). Créé dans l'organisation de l'invitation s'il n'existe pas. */
  user: { id?: string; keycloakSub?: string; email: string; secondFactor?: boolean; displayName?: string };
}

export interface EntitlementReviewItem extends CompanyMember {
  lastActiveAt: string | null;
  suspendedAt: string | null;
  /** Motifs d'attention : INACTIVE (> 60 j), NEVER_ACTIVE, SUSPENDED, OWNER (pouvoir de validation), REVIEWER. */
  reasons: string[];
}

const CreateCompanySchema = z.object({
  name: z.string().min(1).max(200),
  countryCode: z.string().length(2),
  packCode: z.string().min(2).max(8).optional(),
  currency: z.string().length(3).optional(),
  accountingSystem: z.enum(["NORMAL", "SMT"]).optional(),
  taxRegime: z.string().max(60).optional(),
  taxIds: z.record(z.string()).optional(),
  fiscalYear: z.object({
    code: z.string().min(1).max(20),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

/**
 * Organisations (cabinet, entreprise, groupe), utilisateurs, dossiers,
 * invitations, membres et rôles, cycle de vie des comptes.
 *
 * Toutes les requêtes passent par withTenant() : la RLS s'applique même si le
 * service est appelé avec le rôle applicatif.
 */
export class OrganizationService {
  private readonly loadPack: (code: string) => CountryPack;
  private readonly packs = new Map<string, CountryPack>();

  constructor(
    private readonly db: Db,
    opts: { loadPack?: (code: string) => CountryPack } = {},
  ) {
    this.loadPack = opts.loadPack ?? defaultLoadPack;
  }

  // ---------------------------------------------------------------- organisation

  /** Crée une organisation. Un cabinet (FIRM) exige toujours la MFA. */
  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    const id = randomUUID(); // la politique RLS d'organization exige id = app_organization_id() à l'insertion
    const mfaRequired = input.kind === "FIRM";
    const [row] = await withTenant(this.db, { tenantId: "", organizationId: id }, (tx) =>
      tx`INSERT INTO organization (id, name, kind, plan, mfa_required)
         VALUES (${id}, ${input.name}, ${input.kind}, ${input.plan ?? "TRIAL"}, ${mfaRequired})
         RETURNING *`,
    );
    return mapOrganization(row!);
  }

  async getOrganization(ctx: OrganizationContext): Promise<Organization> {
    const [row] = await withTenant(this.db, orgCtx(ctx), (tx) => tx`SELECT * FROM organization WHERE id = ${ctx.organizationId}`);
    if (!row) throw new PortalError("NOT_FOUND", "Organisation introuvable");
    return mapOrganization(row);
  }

  /**
   * Exigence MFA. Pour un cabinet elle ne se désactive pas. Le front lit
   * `mfaRequired` pour exiger la configuration TOTP/WebAuthn ; côté Keycloak,
   * le realm impose l'action requise « Configure OTP » aux utilisateurs des
   * organisations FIRM (voir infra/keycloak).
   */
  async setMfaRequired(ctx: OrganizationContext, required: boolean): Promise<Organization> {
    const current = await this.getOrganization(ctx);
    if (current.kind === "FIRM" && !required) throw new PortalError("MFA_REQUIRED_FOR_FIRM", "La MFA est obligatoire pour un cabinet");
    const [row] = await withTenant(this.db, orgCtx(ctx), (tx) =>
      tx`UPDATE organization SET mfa_required = ${required} WHERE id = ${ctx.organizationId} RETURNING *`,
    );
    return mapOrganization(row!);
  }

  // ---------------------------------------------------------------- utilisateurs

  async createUser(input: CreateUserInput): Promise<AppUser> {
    const [row] = await withTenant(this.db, { tenantId: "", organizationId: input.organizationId }, (tx) =>
      tx`INSERT INTO app_user (id, organization_id, keycloak_sub, email, display_name, locale)
         VALUES (${input.id ?? randomUUID()}, ${input.organizationId}, ${input.keycloakSub ?? null}, ${input.email}, ${input.displayName}, ${input.locale ?? "fr"})
         RETURNING *`,
    );
    return mapUser(row!);
  }

  async listUsers(ctx: OrganizationContext): Promise<AppUser[]> {
    const rows = await withTenant(this.db, orgCtx(ctx), (tx) => tx`SELECT * FROM app_user WHERE organization_id = ${ctx.organizationId} ORDER BY email`);
    return rows.map(mapUser);
  }

  /** Marque une activité (connexion, appel API) : base de la suspension pour inactivité. */
  async touchActivity(userId: string): Promise<void> {
    await withTenant(this.db, { tenantId: "", userId }, (tx) => tx`UPDATE app_user SET last_active_at = now() WHERE id = ${userId}`);
  }

  // ---------------------------------------------------------------- dossiers

  /**
   * Crée un dossier : plan SYSCOHADA, journaux et premier exercice via
   * seedCompany, puis surcharges du plan de comptes du pack pays
   * (chart_overrides : sous-comptes nationaux tels que 4471 ITS, 4311 CNPS).
   */
  async createCompany(organizationId: string, rawInput: CreateCompanyInput): Promise<CompanySummary> {
    const parsed = CreateCompanySchema.safeParse(rawInput);
    if (!parsed.success) throw new PortalError("VALIDATION", "Dossier invalide", parsed.error.issues);
    const input = parsed.data;
    const pack = this.pack(input.packCode ?? input.countryCode.toLowerCase());
    const accountingSystem = input.accountingSystem ?? "NORMAL";
    if (!pack.identity.accounting_systems.includes(accountingSystem)) {
      throw new PortalError("VALIDATION", `Système ${accountingSystem} non prévu par le pack ${pack.code}`);
    }
    const { companyId } = await seedCompany(this.db, {
      organizationId,
      name: input.name,
      countryCode: input.countryCode.toUpperCase(),
      currency: input.currency ?? pack.identity.currency,
      accountingSystem,
      packVersion: `${pack.code}@${pack.version}`,
      fiscalYear: input.fiscalYear,
    });
    const [row] = await withTenant(this.db, { tenantId: companyId, organizationId }, async (tx) => {
      for (const o of pack.chart_overrides) {
        const cls = Number(o.number[0]);
        await tx`
          INSERT INTO account (tenant_id, number, label, class, nature, lettrable, postable)
          VALUES (${companyId}, ${o.number}, ${o.label}, ${cls}, ${natureOfClass(cls)}, ${o.lettrable ?? false}, true)
          ON CONFLICT (tenant_id, number) DO UPDATE
            SET label = EXCLUDED.label,
                lettrable = ${o.lettrable === undefined ? tx`account.lettrable` : o.lettrable}`;
        // Un compte qui reçoit un sous-compte n'est plus imputable (convention du gabarit).
        await tx`UPDATE account SET postable = false WHERE tenant_id = ${companyId} AND number <> ${o.number} AND ${o.number} LIKE number || '%'`;
      }
      if (input.taxRegime || input.taxIds) {
        // Les identifiants fiscaux sont chiffrés au repos (docs/SECURITY.md §7) :
        // la fusion se fait en clair en mémoire, puis on réécrit un seul chiffré
        // et on laisse la colonne jsonb vide.
        let taxIdsEnc: string | null | undefined;
        if (input.taxIds) {
          const cipher = await tenantCipherIn(tx, companyId);
          const [current] = await tx`SELECT tax_ids, tax_ids_enc FROM company WHERE id = ${companyId}`;
          const merged = { ...decryptTaxIds(cipher, current?.tax_ids_enc as string | null, current?.tax_ids as Record<string, unknown> | null), ...input.taxIds };
          taxIdsEnc = encryptTaxIds(cipher, merged);
        }
        await tx`
          UPDATE company SET tax_regime = coalesce(${input.taxRegime ?? null}, tax_regime)
            ${taxIdsEnc === undefined ? tx`` : tx`, tax_ids = '{}'::jsonb, tax_ids_enc = ${taxIdsEnc}`}
          WHERE id = ${companyId}`;
      }
      return tx`SELECT * FROM company WHERE id = ${companyId}`;
    });
    return mapCompany(row!);
  }

  async listCompanies(ctx: OrganizationContext): Promise<CompanySummary[]> {
    const rows = await withTenant(this.db, orgCtx(ctx), (tx) => tx`SELECT * FROM company WHERE organization_id = ${ctx.organizationId} ORDER BY name`);
    return rows.map(mapCompany);
  }

  // ---------------------------------------------------------------- invitations

  /** Crée une invitation ; le jeton en clair n'est renvoyé qu'ici, la base ne garde que son hash. */
  async invite(ctx: OrganizationContext, input: InviteInput): Promise<{ invitation: Invitation; token: string }> {
    if (!MEMBER_ROLES.includes(input.role)) throw new PortalError("VALIDATION", `Rôle inconnu : ${input.role}`);
    if (input.companyIds.length === 0) throw new PortalError("VALIDATION", "Au moins un dossier requis");
    const ttl = Math.min(input.ttlHours ?? INVITATION_MAX_TTL_HOURS, INVITATION_MAX_TTL_HOURS);
    if (ttl <= 0) throw new PortalError("VALIDATION", "Durée de validité invalide");
    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const row = await withTenant(this.db, orgCtx(ctx), async (tx) => {
      const known = await tx`SELECT id FROM company WHERE organization_id = ${ctx.organizationId} AND id = ANY(${input.companyIds}::uuid[])`;
      if (known.length !== new Set(input.companyIds).size) throw new PortalError("NOT_FOUND", "Un des dossiers n'appartient pas à l'organisation");
      const [inserted] = await tx`
        INSERT INTO invitation (organization_id, email, role, company_ids, token_hash, invited_by, expires_at)
        VALUES (${ctx.organizationId}, ${input.email.trim().toLowerCase()}, ${input.role}, ${tx.json(input.companyIds)}, ${tokenHash}, ${ctx.userId ?? null},
                now() + make_interval(hours => ${ttl}))
        RETURNING *`;
      return inserted!;
    });
    return { invitation: mapInvitation(row), token };
  }

  async listInvitations(ctx: OrganizationContext, opts: { pending?: boolean } = {}): Promise<Invitation[]> {
    const rows = await withTenant(this.db, orgCtx(ctx), (tx) =>
      tx`SELECT * FROM invitation WHERE organization_id = ${ctx.organizationId}
         ${opts.pending ? tx`AND accepted_at IS NULL AND expires_at > now()` : tx``}
         ORDER BY created_at DESC`,
    );
    return rows.map(mapInvitation);
  }

  /**
   * Accepte une invitation : l'utilisateur connecté est retrouvé (id, puis
   * keycloak_sub) ou créé dans l'organisation invitante, puis rattaché à
   * chaque dossier avec le rôle de l'invitation. Chaque rattachement est audité.
   */
  async acceptInvitation(input: AcceptInvitationInput): Promise<{ userId: string; organizationId: string; role: MemberRole; companyIds: string[] }> {
    const [inv] = await this.db`SELECT * FROM invitation_by_token_hash(${hashInvitationToken(input.token)})`;
    if (!inv) throw new PortalError("INVITATION_INVALID", "Invitation introuvable");
    if (inv.accepted_at) throw new PortalError("INVITATION_ACCEPTED", "Invitation déjà acceptée");
    if (new Date(iso(inv.expires_at)).getTime() < Date.now()) throw new PortalError("INVITATION_EXPIRED", "Invitation expirée");
    if (input.user.email.trim().toLowerCase() !== str(inv.email).trim().toLowerCase()) {
      throw new PortalError("FORBIDDEN", "Cette invitation est destinée à une autre adresse");
    }
    const organizationId = str(inv.organization_id);
    const role = str(inv.role) as MemberRole;
    const companyIds = (inv.company_ids as string[]) ?? [];

    const userId = await withTenant(this.db, { tenantId: "", organizationId, ...(input.user.id ? { userId: input.user.id } : {}) }, async (tx) => {
      const [organization] = await tx`SELECT mfa_required FROM organization WHERE id = ${organizationId}`;
      if (organization?.mfa_required && !input.user.secondFactor) throw new PortalError("MFA_REQUIRED", "Authentification multifacteur requise pour cette organisation");
      let user: Row | undefined;
      const email = input.user.email;
      // Bootstrap and invitation acceptance must serialize on the verified
      // email, even when RLS would otherwise hide the other organization.
      await tx`SELECT pg_advisory_xact_lock(hashtext(lower(${email})))`;
      // SECURITY DEFINER lookup deliberately performs the global collision
      // check; its result is informational here, the invitation still owns
      // the invited organization's membership decision.
      const [eligibility] = await tx`SELECT state FROM auth_bootstrap_lookup(${input.user.keycloakSub ?? ""}, ${email})`;
      if (input.user.id) [user] = await tx`SELECT id, organization_id, keycloak_sub FROM app_user WHERE id = ${input.user.id}`;
      if (!user && input.user.keycloakSub) [user] = await tx`SELECT id, organization_id, keycloak_sub FROM app_user WHERE keycloak_sub = ${input.user.keycloakSub}`;
      if (user && (str(user.organization_id) !== organizationId || (user.keycloak_sub && user.keycloak_sub !== input.user.keycloakSub))) {
        throw new PortalError("FORBIDDEN", "Compte rattaché à une autre organisation ou identité");
      }
      // A user already belonging to this organization may safely retry an
      // invitation. A new row, however, is only legal for a globally eligible
      // email: bootstrap/replay/linked/suspended/ambiguous identities must
      // never be duplicated into the invited organization.
      if (!user && eligibility?.state !== "ELIGIBLE") {
        throw new PortalError("CONFLICT", "Cette adresse est déjà rattachée à un compte ARCOMPT");
      }
      if (!user) {
        [user] = await tx`
          INSERT INTO app_user (id, organization_id, keycloak_sub, email, display_name, last_active_at)
          VALUES (${input.user.id ?? randomUUID()}, ${organizationId}, ${input.user.keycloakSub ?? null}, ${email}, ${input.user.displayName ?? email}, now())
          RETURNING id`;
      }
      const uid = str(user!.id);
      const [updated] = await tx`UPDATE invitation SET accepted_at = now(), accepted_by = ${uid}
        WHERE id = ${inv.id} AND accepted_at IS NULL AND expires_at > now() RETURNING id`;
      if (!updated) throw new PortalError("INVITATION_ACCEPTED", "Invitation déjà acceptée ou expirée");
      for (const companyId of companyIds) {
        await tx`SELECT set_config('app.tenant_id', ${companyId}, true)`;
        await tx`SELECT set_config('app.user_id', ${uid}, true)`;
        const [before] = await tx`SELECT role FROM company_member WHERE company_id = ${companyId} AND user_id = ${uid}`;
        await tx`INSERT INTO company_member (company_id, user_id, role) VALUES (${companyId}, ${uid}, ${role})
                 ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
        await audit(tx, {
          tenantId: companyId, userId: uid, action: "MEMBER_INVITATION_ACCEPTED", entity: "company_member", entityId: `${companyId}:${uid}`,
          before: before ? { role: before.role } : null, after: { role, invitationId: inv.id },
        });
      }
      return uid;
    });
    return { userId, organizationId, role, companyIds };
  }

  // ---------------------------------------------------------------- membres et rôles

  async listMembers(ctx: OrganizationContext, companyId?: string): Promise<CompanyMember[]> {
    const rows = await withTenant(this.db, orgCtx(ctx), (tx) =>
      tx`SELECT m.company_id, c.name AS company_name, m.user_id, u.email, u.display_name, u.registration_number, m.role
         FROM company_member m
         JOIN company c ON c.id = m.company_id
         LEFT JOIN app_user u ON u.id = m.user_id
         WHERE c.organization_id = ${ctx.organizationId} ${companyId ? tx`AND m.company_id = ${companyId}` : tx``}
         ORDER BY c.name, u.email NULLS LAST, m.user_id`,
    );
    // Fiscal years are tenant-isolated even when an owner may list members
    // across every company in the organization.
    const exerciseCodes = new Map(await Promise.all([...new Set(rows.map((r) => str(r.company_id)))].map(async (id) => {
      const [year] = await withTenant(this.db, { tenantId: id, organizationId: ctx.organizationId, ...(ctx.userId ? { userId: ctx.userId } : {}) }, (tx) =>
        tx`SELECT code FROM fiscal_year WHERE tenant_id = ${id}
           ORDER BY (status = 'OPEN') DESC, start_date DESC LIMIT 1`);
      return [id, year?.code ?? null] as const;
    })));
    return rows.map((r) => mapMember({ ...r, exercise_code: exerciseCodes.get(str(r.company_id)) ?? null }));
  }

  /** Change (ou crée) le rôle d'un membre sur un dossier ; audité. */
  async setRole(ctx: OrganizationContext, input: { companyId: string; userId: string; role: MemberRole }): Promise<CompanyMember> {
    if (!MEMBER_ROLES.includes(input.role)) throw new PortalError("VALIDATION", `Rôle inconnu : ${input.role}`);
    return withTenant(this.db, { tenantId: input.companyId, organizationId: ctx.organizationId, ...(ctx.userId ? { userId: ctx.userId } : {}) }, async (tx) => {
      const [company] = await tx`SELECT id, name FROM company WHERE id = ${input.companyId} AND organization_id = ${ctx.organizationId}`;
      if (!company) throw new PortalError("NOT_FOUND", "Dossier introuvable dans l'organisation");
      const [before] = await tx`SELECT role FROM company_member WHERE company_id = ${input.companyId} AND user_id = ${input.userId}`;
      if (before && before.role === "OWNER" && input.role !== "OWNER") await this.assertNotLastOwner(tx, input.companyId, input.userId);
      await tx`INSERT INTO company_member (company_id, user_id, role) VALUES (${input.companyId}, ${input.userId}, ${input.role})
               ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
      await audit(tx, {
        tenantId: input.companyId, userId: ctx.userId ?? null, action: before ? "MEMBER_ROLE_SET" : "MEMBER_ADDED", entity: "company_member",
        entityId: `${input.companyId}:${input.userId}`, before: before ? { role: before.role } : null, after: { role: input.role },
      });
      const [u] = await tx`SELECT email, display_name, registration_number FROM app_user WHERE id = ${input.userId}`;
      const [year] = await tx`SELECT code FROM fiscal_year WHERE tenant_id = ${input.companyId}
        ORDER BY (status = 'OPEN') DESC, start_date DESC LIMIT 1`;
      return mapMember({ company_id: input.companyId, company_name: company.name, user_id: input.userId,
        email: u?.email ?? null, display_name: u?.display_name ?? null, registration_number: u?.registration_number,
        exercise_code: year?.code ?? null, role: input.role });
    });
  }

  /** Retire un membre d'un dossier ; refuse de retirer le dernier OWNER ; audité. */
  async removeMember(ctx: OrganizationContext, input: { companyId: string; userId: string }): Promise<void> {
    await withTenant(this.db, { tenantId: input.companyId, organizationId: ctx.organizationId, ...(ctx.userId ? { userId: ctx.userId } : {}) }, async (tx) => {
      const [before] = await tx`SELECT m.role FROM company_member m JOIN company c ON c.id = m.company_id
                                WHERE m.company_id = ${input.companyId} AND m.user_id = ${input.userId} AND c.organization_id = ${ctx.organizationId}`;
      if (!before) throw new PortalError("NOT_FOUND", "Membre introuvable");
      if (before.role === "OWNER") await this.assertNotLastOwner(tx, input.companyId, input.userId);
      await tx`DELETE FROM company_member WHERE company_id = ${input.companyId} AND user_id = ${input.userId}`;
      await audit(tx, {
        tenantId: input.companyId, userId: ctx.userId ?? null, action: "MEMBER_REMOVED", entity: "company_member",
        entityId: `${input.companyId}:${input.userId}`, before: { role: before.role }, after: null,
      });
    });
  }

  private async assertNotLastOwner(tx: Sql, companyId: string, userId: string): Promise<void> {
    const [{ n }] = (await tx`SELECT count(*)::int AS n FROM company_member WHERE company_id = ${companyId} AND role = 'OWNER' AND user_id <> ${userId}`) as unknown as [{ n: number }];
    if (n === 0) throw new PortalError("LAST_OWNER", "Impossible de retirer le dernier dirigeant (OWNER) du dossier");
  }

  // ---------------------------------------------------------------- cycle de vie

  /**
   * Suspend les comptes de l'organisation sans activité depuis `days` jours
   * (défaut 90, SECURITY.md §4). Un compte jamais actif est mesuré depuis sa
   * création. Chaque suspension est auditée sur chacun des dossiers du membre.
   */
  async suspendInactiveAccounts(ctx: OrganizationContext, days = INACTIVITY_SUSPENSION_DAYS): Promise<AppUser[]> {
    const suspended = await withTenant(this.db, orgCtx(ctx), (tx) =>
      tx`UPDATE app_user SET suspended_at = now(), suspended_reason = ${`inactivité > ${days} jours`}
         WHERE organization_id = ${ctx.organizationId} AND suspended_at IS NULL
           AND coalesce(last_active_at, created_at) < now() - make_interval(days => ${days})
         RETURNING *`,
    );
    for (const u of suspended) {
      const memberships = await withTenant(this.db, orgCtx(ctx), (tx) =>
        tx`SELECT m.company_id, m.role FROM company_member m JOIN company c ON c.id = m.company_id WHERE m.user_id = ${u.id} AND c.organization_id = ${ctx.organizationId}`,
      );
      for (const m of memberships) {
        await withTenant(this.db, { tenantId: str(m.company_id), organizationId: ctx.organizationId, ...(ctx.userId ? { userId: ctx.userId } : {}) }, (tx) =>
          audit(tx, { tenantId: str(m.company_id), userId: ctx.userId ?? null, action: "ACCOUNT_SUSPENDED", entity: "app_user", entityId: str(u.id), before: { role: m.role, suspendedAt: null }, after: { role: m.role, reason: u.suspended_reason } }),
        );
      }
    }
    return suspended.map(mapUser);
  }

  async reactivateUser(ctx: OrganizationContext, userId: string): Promise<AppUser> {
    const [row] = await withTenant(this.db, orgCtx(ctx), (tx) =>
      tx`UPDATE app_user SET suspended_at = NULL, suspended_reason = NULL, last_active_at = now()
         WHERE id = ${userId} AND organization_id = ${ctx.organizationId} RETURNING *`,
    );
    if (!row) throw new PortalError("NOT_FOUND", "Utilisateur introuvable");
    return mapUser(row);
  }

  /**
   * Revue (trimestrielle) des droits : chaque rôle attribué sur un dossier de
   * l'organisation, à revalider, avec les motifs d'attention.
   */
  async entitlementReview(ctx: OrganizationContext): Promise<EntitlementReviewItem[]> {
    const rows = await withTenant(this.db, orgCtx(ctx), (tx) =>
      tx`SELECT m.company_id, c.name AS company_name, m.user_id, u.email, u.display_name, m.role,
                u.last_active_at, u.suspended_at, u.created_at
         FROM company_member m
         JOIN company c ON c.id = m.company_id
         LEFT JOIN app_user u ON u.id = m.user_id
         WHERE c.organization_id = ${ctx.organizationId}
         ORDER BY c.name, m.role, u.email NULLS LAST`,
    );
    const members = new Map((await this.listMembers(ctx)).map((m) => [`${m.companyId}:${m.userId}`, m]));
    const now = Date.now();
    return rows.map((r) => {
      const member = members.get(`${str(r.company_id)}:${str(r.user_id)}`);
      if (!member) throw new Error("Member missing from entitlement review");
      const reasons: string[] = [];
      const lastActive = isoOrNull(r.last_active_at);
      if (r.suspended_at) reasons.push("SUSPENDED");
      if (!lastActive) reasons.push("NEVER_ACTIVE");
      else if (now - new Date(lastActive).getTime() > 60 * 86_400_000) reasons.push("INACTIVE");
      if (r.role === "OWNER") reasons.push("OWNER");
      if (r.role === "REVIEWER") reasons.push("REVIEWER");
      if (r.email === null) reasons.push("EXTERNAL_ORGANIZATION");
      return { ...member, lastActiveAt: lastActive, suspendedAt: isoOrNull(r.suspended_at), reasons };
    });
  }

  private pack(code: string): CountryPack {
    let p = this.packs.get(code);
    if (!p) {
      try {
        p = this.loadPack(code);
      } catch (e) {
        throw new PortalError("PACK_UNAVAILABLE", `Pack pays ${code} indisponible : ${(e as Error).message}`);
      }
      this.packs.set(code, p);
    }
    return p;
  }
}

function orgCtx(ctx: OrganizationContext): { tenantId: string; organizationId: string; userId?: string } {
  return { tenantId: "", organizationId: ctx.organizationId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
}

function natureOfClass(cls: number): string {
  switch (cls) {
    case 1:
      return "PASSIF";
    case 2:
    case 3:
    case 5:
      return "ACTIF";
    case 4:
    case 8:
      return "MIXTE";
    case 6:
      return "CHARGE";
    case 7:
      return "PRODUIT";
    default:
      return "ENGAGEMENT";
  }
}

export function mapOrganization(r: Row): Organization {
  const kind = str(r.kind) as OrganizationKind;
  return { id: str(r.id), name: str(r.name), kind, plan: str(r.plan), mfaRequired: kind === "FIRM" || Boolean(r.mfa_required), createdAt: iso(r.created_at) };
}

export function mapUser(r: Row): AppUser {
  return { id: str(r.id), organizationId: str(r.organization_id), email: str(r.email), displayName: str(r.display_name), keycloakSub: strOrNull(r.keycloak_sub), locale: str(r.locale ?? "fr") };
}

export function mapCompany(r: Row): CompanySummary {
  return {
    id: str(r.id), organizationId: str(r.organization_id), name: str(r.name), countryCode: str(r.country_code), currency: str(r.currency),
    accountingSystem: str(r.accounting_system) as "NORMAL" | "SMT", packVersion: str(r.pack_version), taxRegime: strOrNull(r.tax_regime), createdAt: iso(r.created_at),
  };
}

export function mapInvitation(r: Row): Invitation {
  return {
    id: str(r.id), organizationId: str(r.organization_id), email: str(r.email), role: str(r.role) as MemberRole,
    companyIds: (r.company_ids as string[]) ?? [], expiresAt: iso(r.expires_at), acceptedAt: isoOrNull(r.accepted_at), createdAt: iso(r.created_at),
  };
}

export function mapMember(r: Row): CompanyMember {
  // A member from a different organization may be visible through a
  // company_member row while RLS intentionally hides their app_user details.
  const registrationNumber = strOrNull(r.registration_number);
  if ((r.email != null || r.display_name != null) && !registrationNumber) {
    throw new Error("Missing platform registration number");
  }
  if (registrationNumber && !/^[1-9]\d*$/.test(registrationNumber)) throw new Error("Invalid platform registration number");
  const exerciseCode = strOrNull(r.exercise_code);
  return {
    companyId: str(r.company_id), companyName: str(r.company_name), userId: str(r.user_id),
    reference: exerciseCode && registrationNumber ? formatMemberReference(str(r.company_name), exerciseCode, registrationNumber) : null,
    email: strOrNull(r.email), displayName: strOrNull(r.display_name), role: str(r.role) as MemberRole,
  };
}

/** Display-only reference; authentication and authorization still use the opaque IDs. */
export function formatMemberReference(companyName: string, exerciseCode: string, registrationNumber: string): string {
  const part = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const company = part(companyName).slice(0, 32).replace(/-+$/g, "");
  const exercise = part(exerciseCode);
  if (!company || !exercise || !/^[1-9]\d*$/.test(registrationNumber)) {
    throw new Error("Invalid member reference parts");
  }
  return `${company}-${exercise}-${registrationNumber.padStart(6, "0")}`;
}

