// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import type { Sql } from "postgres";
import { PortalError } from "./errors.js";
import { int, isoOrNull, str, strOrNull, type Row } from "./sql.js";

/**
 * Droits fonctionnels d'une organisation, résolus depuis le catalogue
 * subscription_plan (colonne features, migration 0037) et l'abonnement de
 * l'organisation (organization_subscription, repli : organization.plan).
 *
 * Règles de dégradation (jamais de verrouillage des données) :
 * - essai (TRIAL) expiré -> droits de l'offre ESSENTIEL, statut TRIAL_EXPIRED ;
 * - abonnement échu (ended_at dépassé) -> droits ESSENTIEL, statut ENDED.
 * Les compteurs (sièges, dossiers) ne bloquent que les AJOUTS, jamais l'existant.
 */
export interface PlanFeatures {
  payroll: boolean;
  aiAssistant: boolean;
  whiteLabel: boolean;
  firmDashboard: boolean;
  /** Sièges (membres distincts) par organisation ; null = illimité. */
  maxUsers: number | null;
  /** Dossiers par organisation ; null = illimité (facturation au dossier). */
  maxDossiers: number | null;
  /** Durée de l'essai en jours (offre TRIAL). */
  trialDays: number | null;
}

export interface Entitlements {
  organizationId: string;
  /** Offre commerciale actuelle (celle qui est facturée / affichée). */
  planCode: string;
  /** Offre dont les droits s'appliquent réellement (après dégradation). */
  effectivePlanCode: string;
  label: string;
  currency: string;
  pricePerDossier: string;
  features: PlanFeatures;
  quotas: Record<string, number>;
  startedAt: string | null;
  endedAt: string | null;
  trialEndsAt: string | null;
  status: "TRIAL" | "TRIAL_EXPIRED" | "ACTIVE" | "ENDED";
}

const FALLBACK_FEATURES: PlanFeatures = {
  payroll: false, aiAssistant: false, whiteLabel: false, firmDashboard: false,
  maxUsers: 1, maxDossiers: null, trialDays: null,
};

function parseFeatures(raw: unknown): PlanFeatures {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    payroll: f.payroll === true,
    aiAssistant: f.aiAssistant === true,
    whiteLabel: f.whiteLabel === true,
    firmDashboard: f.firmDashboard === true,
    maxUsers: num(f.maxUsers),
    maxDossiers: num(f.maxDossiers),
    trialDays: num(f.trialDays),
  };
}

function parseQuotas(raw: unknown): Record<string, number> {
  const q = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function addDays(dateIso: string, days: number): string {
  const d = new Date(dateIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** À appeler dans une transaction tenant (withTenant) : lit l'offre d'une organisation. */
export async function resolveEntitlements(tx: Sql, organizationId: string): Promise<Entitlements> {
  const [row] = (await tx`
    SELECT o.plan AS org_plan, o.created_at AS org_created_at,
           s.plan_code AS sub_plan_code, s.started_at AS sub_started_at, s.ended_at AS sub_ended_at,
           s.price_per_dossier AS sub_price,
           p.label AS plan_label, p.currency AS plan_currency,
           p.price_per_dossier AS plan_price, p.quotas AS plan_quotas, p.features AS plan_features
    FROM organization o
    LEFT JOIN organization_subscription s ON s.organization_id = o.id
    LEFT JOIN subscription_plan p ON p.code = coalesce(s.plan_code, o.plan)
    WHERE o.id = ${organizationId}`) as Row[];
  if (!row) throw new PortalError("NOT_FOUND", "Organisation introuvable");

  const planCode = strOrNull(row.sub_plan_code) ?? strOrNull(row.org_plan) ?? "TRIAL";
  let features = row.plan_features ? parseFeatures(row.plan_features) : { ...FALLBACK_FEATURES };
  let quotas = parseQuotas(row.plan_quotas);
  let effectivePlanCode = planCode;
  let status: Entitlements["status"] = planCode === "TRIAL" ? "TRIAL" : "ACTIVE";
  let trialEndsAt: string | null = null;

  const degradeToEssentiel = async () => {
    const [ess] = (await tx`SELECT features, quotas FROM subscription_plan WHERE code = 'ESSENTIEL'`) as Row[];
    if (ess) {
      features = parseFeatures(ess.features);
      quotas = parseQuotas(ess.quotas);
    } else {
      features = { ...FALLBACK_FEATURES };
    }
    effectivePlanCode = "ESSENTIEL";
  };

  if (planCode === "TRIAL") {
    const start = isoOrNull(row.sub_started_at) ?? isoOrNull(row.org_created_at);
    const days = features.trialDays ?? 14;
    if (start) {
      trialEndsAt = addDays(start, days);
      if (today() > trialEndsAt) {
        status = "TRIAL_EXPIRED";
        await degradeToEssentiel();
      }
    }
  }
  const endedAt = isoOrNull(row.sub_ended_at);
  if (status === "ACTIVE" && endedAt && today() > endedAt.slice(0, 10)) {
    status = "ENDED";
    await degradeToEssentiel();
  }

  return {
    organizationId,
    planCode,
    effectivePlanCode,
    label: strOrNull(row.plan_label) ?? planCode,
    currency: strOrNull(row.plan_currency) ?? "XOF",
    pricePerDossier: String(row.sub_price ?? row.plan_price ?? "0"),
    features,
    quotas,
    startedAt: isoOrNull(row.sub_started_at),
    endedAt,
    trialEndsAt,
    status,
  };
}

/** Variante dossier : retrouve l'organisation du dossier puis ses droits. */
export async function resolveEntitlementsForCompany(tx: Sql, companyId: string): Promise<Entitlements> {
  const [row] = (await tx`SELECT organization_id FROM company WHERE id = ${companyId}`) as Row[];
  if (!row) throw new PortalError("NOT_FOUND", "Dossier introuvable");
  return resolveEntitlements(tx, str(row.organization_id));
}

/** Nombre de sièges utilisés : membres distincts + invitations en attente vers de nouveaux venus. */
export async function seatsUsed(tx: Sql, organizationId: string): Promise<number> {
  const [members] = (await tx`
    SELECT count(DISTINCT m.user_id)::int AS n
    FROM company_member m JOIN company c ON c.id = m.company_id
    WHERE c.organization_id = ${organizationId}`) as Row[];
  const [pending] = (await tx`
    SELECT count(*)::int AS n FROM invitation i
    WHERE i.organization_id = ${organizationId} AND i.accepted_at IS NULL AND i.expires_at > now()
      AND NOT EXISTS (
        SELECT 1 FROM company_member m JOIN company c ON c.id = m.company_id
        JOIN app_user u ON u.id = m.user_id
        WHERE c.organization_id = ${organizationId} AND lower(u.email) = lower(i.email))`) as Row[];
  return int(members?.n) + int(pending?.n);
}

export async function assertSeatAvailable(tx: Sql, organizationId: string): Promise<void> {
  const ent = await resolveEntitlements(tx, organizationId);
  if (ent.features.maxUsers === null) return;
  const used = await seatsUsed(tx, organizationId);
  if (used >= ent.features.maxUsers) {
    throw new PortalError(
      "PLAN_UPGRADE_REQUIRED",
      `Votre offre ${ent.label} est limitée à ${ent.features.maxUsers} utilisateur(s) par organisation. Passez à une offre supérieure pour inviter d'autres membres.`,
      { feature: "seats", limit: ent.features.maxUsers, used, planCode: ent.planCode, effectivePlanCode: ent.effectivePlanCode },
    );
  }
}

export async function assertDossierSlotAvailable(tx: Sql, organizationId: string): Promise<void> {
  const ent = await resolveEntitlements(tx, organizationId);
  if (ent.features.maxDossiers === null) return;
  const [row] = (await tx`SELECT count(*)::int AS n FROM company WHERE organization_id = ${organizationId}`) as Row[];
  if (int(row?.n) >= ent.features.maxDossiers) {
    throw new PortalError(
      "PLAN_UPGRADE_REQUIRED",
      `Votre offre ${ent.label} est limitée à ${ent.features.maxDossiers} dossier(s). Passez à une offre supérieure pour créer d'autres dossiers.`,
      { feature: "dossiers", limit: ent.features.maxDossiers, planCode: ent.planCode, effectivePlanCode: ent.effectivePlanCode },
    );
  }
}

export function assertFeature(ent: Entitlements, feature: keyof PlanFeatures, label: string, requiredPlan: string): void {
  if (ent.features[feature]) return;
  throw new PortalError(
    "PLAN_UPGRADE_REQUIRED",
    `${label} n'est pas inclus dans votre offre ${ent.label}. Passez à l'offre ${requiredPlan} pour l'activer.`,
    { feature, planCode: ent.planCode, effectivePlanCode: ent.effectivePlanCode, requiredPlan },
  );
}
