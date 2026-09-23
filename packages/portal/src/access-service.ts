import { withTenant, type Db } from "@arcompt/db";
import { adminAccessMail, breakGlassMail, legalFooterFromEnv } from "@arcompt/mailer";
import { PortalError } from "./errors.js";
import type { Notifier } from "./notifier.js";
import { audit, int, iso, isoOrNull, str, strOrNull, type Row } from "./sql.js";

/** Durée maximale d'un accès d'urgence (SECURITY.md §4). */
export const BREAK_GLASS_MAX_HOURS = 4;

export type BreakGlassStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "REVOKED";

export interface BreakGlassRequest {
  id: string;
  tenantId: string;
  requesterId: string;
  approverId: string | null;
  reason: string;
  status: BreakGlassStatus;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string;
  /** APPROVED et non expiré. */
  active: boolean;
}

export interface AdminAccessRecord {
  id: number;
  tenantId: string;
  adminUserId: string;
  reason: string;
  breakGlassRequestId: string | null;
  notifiedCount: number;
  notifiedAt: string | null;
  accessedAt: string;
}

/**
 * Accès administrateur neutralisé (SECURITY.md §4) :
 *  - tout accès d'un technicien à un dossier est journalisé (admin_access_log,
 *    insertion seule) et notifie les dirigeants du dossier par le Notifier ;
 *  - l'accès d'urgence (break-glass) est demandé par un administrateur,
 *    approuvé par un second, limité à 4 h, et chaque étape est dans audit_log.
 */
export class AccessService {
  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier,
    private readonly opts: {
      /** Mentions légales en pied des e-mails ; défaut : `MAIL_LEGAL_FOOTER`. */
      legalFooter?: string;
      /** Puits des avertissements (notification non remise) ; défaut : console.warn. */
      warn?: (message: string) => void;
    } = {},
  ) {}

  private warn(message: string): void {
    (this.opts.warn ?? ((m: string) => console.warn(m)))(message);
  }

  /**
   * Journalise l'accès d'un administrateur au dossier et prévient ses
   * dirigeants (OWNER) : « un technicien a accédé à votre dossier ».
   * Si un accès d'urgence est cité, il doit être approuvé, non expiré et
   * demandé par le même administrateur.
   */
  async recordAdminAccess(companyId: string, adminUserId: string, reason: string, opts: { breakGlassRequestId?: string } = {}): Promise<{ record: AdminAccessRecord; notified: string[] }> {
    if (reason.trim().length < 5) throw new PortalError("VALIDATION", "Motif d'accès requis (5 caractères minimum)");
    const { record, organizationId, breakGlassExpiresAt } = await withTenant(this.db, { tenantId: companyId, userId: adminUserId }, async (tx) => {
      const [company] = await tx`SELECT organization_id, name FROM company WHERE id = ${companyId}`;
      if (!company) throw new PortalError("NOT_FOUND", "Dossier introuvable");
      let breakGlassExpiresAt: string | null = null;
      if (opts.breakGlassRequestId) {
        const [bg] = await tx`SELECT * FROM break_glass_request WHERE id = ${opts.breakGlassRequestId} AND tenant_id = ${companyId}`;
        if (!bg) throw new PortalError("NOT_FOUND", "Demande d'accès d'urgence introuvable");
        const b = mapBreakGlass(bg);
        if (!b.active) throw new PortalError("FORBIDDEN", "Accès d'urgence non approuvé ou expiré");
        if (b.requesterId !== adminUserId) throw new PortalError("FORBIDDEN", "Accès d'urgence demandé par un autre administrateur");
        breakGlassExpiresAt = b.expiresAt;
      }
      const [row] = await tx`
        INSERT INTO admin_access_log (tenant_id, admin_user_id, reason, break_glass_request_id)
        VALUES (${companyId}, ${adminUserId}, ${reason}, ${opts.breakGlassRequestId ?? null}) RETURNING *`;
      await audit(tx, {
        tenantId: companyId, userId: adminUserId, action: "ADMIN_ACCESS", entity: "admin_access_log", entityId: str(row!.id),
        after: { reason, breakGlassRequestId: opts.breakGlassRequestId ?? null },
      });
      return { record: mapAdminAccess(row!), organizationId: str(company.organization_id), breakGlassExpiresAt };
    });

    // Dirigeants du dossier : membres OWNER dont le compte est lisible (même organisation).
    const owners = await withTenant(this.db, { tenantId: companyId, organizationId }, (tx) =>
      tx`SELECT u.id, u.email, c.name AS company_name FROM company_member m
         JOIN app_user u ON u.id = m.user_id JOIN company c ON c.id = m.company_id
         WHERE m.company_id = ${companyId} AND m.role = 'OWNER' AND u.suspended_at IS NULL`,
    );
    const legalFooter = this.opts.legalFooter ?? legalFooterFromEnv();
    const notified: string[] = [];
    for (const o of owners) {
      try {
        // Un accès d'urgence n'est pas un accès ordinaire : le dirigeant doit
        // lire qu'un second administrateur l'a approuvé et quand il prend fin.
        const mail = breakGlassExpiresAt
          ? breakGlassMail({ companyName: str(o.company_name), accessedAt: record.accessedAt, reason, expiresAt: breakGlassExpiresAt, legalFooter })
          : adminAccessMail({ companyName: str(o.company_name), accessedAt: record.accessedAt, reason, legalFooter });
        await this.notifier.send({
          channel: "EMAIL",
          to: str(o.email),
          subject: mail.subject,
          body: mail.text,
          html: mail.html,
          tenantId: companyId,
          reference: `admin-access:${record.id}`,
        });
        notified.push(str(o.id));
      } catch (e) {
        // L'échec d'une notification ne masque jamais l'accès : il reste
        // journalisé et notified_count le reflète. Il ne reste pas muet pour
        // autant — un dirigeant non prévenu est un fait d'exploitation.
        this.warn(`[arcompt] notification d'accès administrateur non remise (dossier ${companyId}, accès ${record.id}) : ${(e as Error).message}`);
      }
    }
    const [updated] = await withTenant(this.db, { tenantId: companyId, userId: adminUserId }, (tx) =>
      tx`UPDATE admin_access_log SET notified_count = ${notified.length}, notified_at = ${notified.length > 0 ? tx`now()` : null} WHERE id = ${record.id} RETURNING *`,
    );
    return { record: mapAdminAccess(updated!), notified };
  }

  async listAdminAccess(companyId: string, limit = 100): Promise<AdminAccessRecord[]> {
    const rows = await withTenant(this.db, { tenantId: companyId }, (tx) =>
      tx`SELECT * FROM admin_access_log WHERE tenant_id = ${companyId} ORDER BY accessed_at DESC LIMIT ${limit}`,
    );
    return rows.map(mapAdminAccess);
  }

  /** Demande d'accès d'urgence : durée ≤ 4 h, auditée. */
  async requestBreakGlass(input: { tenantId: string; requesterId: string; reason: string; durationHours?: number }): Promise<BreakGlassRequest> {
    const hours = input.durationHours ?? BREAK_GLASS_MAX_HOURS;
    if (!(hours > 0) || hours > BREAK_GLASS_MAX_HOURS) throw new PortalError("VALIDATION", `Durée d'accès d'urgence entre 0 et ${BREAK_GLASS_MAX_HOURS} heures`);
    if (input.reason.trim().length < 5) throw new PortalError("VALIDATION", "Motif requis (5 caractères minimum)");
    return withTenant(this.db, { tenantId: input.tenantId, userId: input.requesterId }, async (tx) => {
      const [row] = await tx`
        INSERT INTO break_glass_request (tenant_id, requester_id, reason, expires_at)
        VALUES (${input.tenantId}, ${input.requesterId}, ${input.reason}, now() + make_interval(mins => ${Math.round(hours * 60)}))
        RETURNING *`;
      const r = mapBreakGlass(row!);
      await audit(tx, { tenantId: input.tenantId, userId: input.requesterId, action: "BREAK_GLASS_REQUESTED", entity: "break_glass_request", entityId: r.id, after: r });
      return r;
    });
  }

  /** Approbation par un second administrateur (≠ demandeur), avant expiration ; auditée. */
  async approveBreakGlass(input: { tenantId: string; requestId: string; approverId: string }): Promise<BreakGlassRequest> {
    return this.decide(input.tenantId, input.requestId, input.approverId, "APPROVED");
  }

  async rejectBreakGlass(input: { tenantId: string; requestId: string; approverId: string }): Promise<BreakGlassRequest> {
    return this.decide(input.tenantId, input.requestId, input.approverId, "REJECTED");
  }

  /** Révocation anticipée d'un accès approuvé (par n'importe quel administrateur) ; auditée. */
  async revokeBreakGlass(input: { tenantId: string; requestId: string; userId: string }): Promise<BreakGlassRequest> {
    return withTenant(this.db, { tenantId: input.tenantId, userId: input.userId }, async (tx) => {
      const [before] = await tx`SELECT * FROM break_glass_request WHERE id = ${input.requestId} AND tenant_id = ${input.tenantId}`;
      if (!before) throw new PortalError("NOT_FOUND", "Demande introuvable");
      if (before.status !== "APPROVED") throw new PortalError("CONFLICT", "Seul un accès approuvé se révoque");
      const [row] = await tx`UPDATE break_glass_request SET status = 'REVOKED', decided_at = now() WHERE id = ${input.requestId} RETURNING *`;
      const r = mapBreakGlass(row!);
      await audit(tx, { tenantId: input.tenantId, userId: input.userId, action: "BREAK_GLASS_REVOKED", entity: "break_glass_request", entityId: r.id, before: mapBreakGlass(before), after: r });
      return r;
    });
  }

  async listBreakGlass(tenantId: string, opts: { activeOnly?: boolean } = {}): Promise<BreakGlassRequest[]> {
    const rows = await withTenant(this.db, { tenantId }, (tx) =>
      tx`SELECT * FROM break_glass_request WHERE tenant_id = ${tenantId}
         ${opts.activeOnly ? tx`AND status = 'APPROVED' AND expires_at > now()` : tx``}
         ORDER BY requested_at DESC`,
    );
    return rows.map(mapBreakGlass);
  }

  private async decide(tenantId: string, requestId: string, approverId: string, status: "APPROVED" | "REJECTED"): Promise<BreakGlassRequest> {
    return withTenant(this.db, { tenantId, userId: approverId }, async (tx) => {
      const [before] = await tx`SELECT * FROM break_glass_request WHERE id = ${requestId} AND tenant_id = ${tenantId}`;
      if (!before) throw new PortalError("NOT_FOUND", "Demande introuvable");
      if (str(before.requester_id) === approverId) throw new PortalError("FORBIDDEN", "Le demandeur ne peut pas approuver sa propre demande");
      if (before.status !== "REQUESTED") throw new PortalError("CONFLICT", `Demande déjà ${str(before.status)}`);
      if (new Date(iso(before.expires_at)).getTime() <= Date.now()) throw new PortalError("CONFLICT", "Demande expirée");
      const [row] = await tx`UPDATE break_glass_request SET status = ${status}, approver_id = ${approverId}, decided_at = now() WHERE id = ${requestId} RETURNING *`;
      const r = mapBreakGlass(row!);
      await audit(tx, { tenantId, userId: approverId, action: `BREAK_GLASS_${status}`, entity: "break_glass_request", entityId: r.id, before: mapBreakGlass(before), after: r });
      return r;
    });
  }
}

export function mapBreakGlass(r: Row): BreakGlassRequest {
  const status = str(r.status) as BreakGlassStatus;
  const expiresAt = iso(r.expires_at);
  return {
    id: str(r.id), tenantId: str(r.tenant_id), requesterId: str(r.requester_id), approverId: strOrNull(r.approver_id), reason: str(r.reason), status,
    requestedAt: iso(r.requested_at), decidedAt: isoOrNull(r.decided_at), expiresAt, active: status === "APPROVED" && new Date(expiresAt).getTime() > Date.now(),
  };
}

export function mapAdminAccess(r: Row): AdminAccessRecord {
  return {
    id: int(r.id), tenantId: str(r.tenant_id), adminUserId: str(r.admin_user_id), reason: str(r.reason), breakGlassRequestId: strOrNull(r.break_glass_request_id),
    notifiedCount: int(r.notified_count), notifiedAt: isoOrNull(r.notified_at), accessedAt: iso(r.accessed_at),
  };
}
