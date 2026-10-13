// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { withTenant } from "@arcompt/db";
import { resolveEntitlements, resolveEntitlementsForCompany, type Entitlements } from "@arcompt/portal";
import type { Sql } from "postgres";
import type { AuthContext } from "./auth.js";

/** Droits de l'organisation de l'appelant (contexte tenant de la requête). */
export async function entitlementsForAuth(db: Sql, auth: AuthContext): Promise<Entitlements | null> {
  if (!auth.tenantId && !auth.organizationId) return null;
  return withTenant(db, auth, (tx) =>
    auth.organizationId
      ? resolveEntitlements(tx, auth.organizationId)
      : resolveEntitlementsForCompany(tx, auth.tenantId),
  );
}

/** Corps d'erreur uniforme quand une fonctionnalité n'est pas dans l'offre. */
export function upgradeRequiredBody(ent: Entitlements, feature: string, label: string, requiredPlan: string) {
  return {
    error: {
      code: "PLAN_UPGRADE_REQUIRED",
      message: `${label} n'est pas inclus dans l'offre ${ent.label}. Passez à l'offre ${requiredPlan} pour l'activer.`,
      details: { feature, planCode: ent.planCode, effectivePlanCode: ent.effectivePlanCode, requiredPlan },
    },
  };
}
