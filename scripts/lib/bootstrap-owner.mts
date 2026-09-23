// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { listPackCodes, loadPack } from "../../packages/country-packs/src/index.js";
import type { Db } from "../../packages/db/src/client.js";
import { natureOfClass, resolveChart } from "../../packages/db/src/chart.js";
import { DEFAULT_JOURNALS, monthlyRanges } from "../../packages/ledger/src/memory-store.js";
import { audit } from "../../packages/portal/src/sql.js";

export interface FirstOwnerInput {
  email: string;
  name: string;
  organization: string;
  company: string;
  country: string;
  year: number;
  kind: "COMPANY" | "FIRM";
}

export interface FirstOwnerPreview {
  database: string;
  packVersion: string;
  packStatus: string;
  currency: string;
  existing?: { organizationId: string; companyId: string; userId: string };
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) throw new Error(`${label} doit contenir entre 1 et 200 caractères.`);
  return trimmed;
}

export function validateFirstOwnerInput(input: FirstOwnerInput): FirstOwnerInput {
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Adresse e-mail invalide.");
  const country = input.country.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(country) || !listPackCodes().includes(country)) {
    throw new Error(`Pack pays inconnu : ${country}. Codes disponibles : ${listPackCodes().join(", ")}.`);
  }
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) throw new Error("Exercice invalide (2000–2100).");
  if (input.kind !== "COMPANY" && input.kind !== "FIRM") throw new Error("Organisation : COMPANY ou FIRM requis.");
  return {
    email,
    name: required(input.name, "Nom du titulaire"),
    organization: required(input.organization, "Nom de l'organisation"),
    company: required(input.company, "Nom du dossier"),
    country,
    year: input.year,
    kind: input.kind,
  };
}

/**
 * Inspecte sans modifier. Exige un compte d'administration de la base :
 * une lecture RLS partielle pourrait masquer un homonyme et permettre le vol
 * du rattachement OIDC par adresse e-mail vérifiée.
 */
export async function previewFirstOwner(db: Db, raw: FirstOwnerInput): Promise<FirstOwnerPreview> {
  const input = validateFirstOwnerInput(raw);
  const pack = loadPack(input.country);
  const [session] = await db`
    SELECT current_database() AS database, r.rolsuper, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (!session || (!session.rolsuper && !session.rolbypassrls)) {
    throw new Error("Utilisez le compte d'administration/migration de la base (lecture globale requise), jamais le rôle applicatif.");
  }
  const database = String(session.database);
  const users = await db`
    SELECT u.id AS user_id, u.keycloak_sub, u.organization_id, o.name AS organization_name, o.kind,
           c.id AS company_id, c.name AS company_name, c.country_code, m.role
    FROM app_user u
    JOIN organization o ON o.id = u.organization_id
    LEFT JOIN company_member m ON m.user_id = u.id
    LEFT JOIN company c ON c.id = m.company_id
    WHERE lower(u.email) = ${input.email}`;

  if (users.length > 0) {
    const same = users.length === 1 && users[0]!.organization_name === input.organization
      && users[0]!.kind === input.kind && users[0]!.company_name === input.company
      && String(users[0]!.country_code).trim().toLowerCase() === input.country
      && users[0]!.role === "OWNER";
    if (!same) throw new Error("Cette adresse existe déjà dans une autre configuration (ou dans un compte partiellement créé). Aucune modification automatique.");
    return {
      database, packVersion: `${pack.code}@${pack.version}`, packStatus: pack.status,
      currency: pack.identity.currency,
      existing: {
        organizationId: String(users[0]!.organization_id),
        companyId: String(users[0]!.company_id),
        userId: String(users[0]!.user_id),
      },
    };
  }
  // Ce programme est réservé à la première installation, pas un moyen de
  // contourner les invitations et les droits du portail sur une base peuplée.
  const [counts] = await db`
    SELECT (SELECT count(*)::int FROM organization) AS organizations,
           (SELECT count(*)::int FROM app_user) AS users,
           (SELECT count(*)::int FROM company) AS companies`;
  if (Number(counts?.organizations) || Number(counts?.users) || Number(counts?.companies)) {
    throw new Error("La base contient déjà des organisations ou utilisateurs. Utilisez une base vierge pour ce premier OWNER ; aucune donnée existante n'est effacée.");
  }
  return { database, packVersion: `${pack.code}@${pack.version}`, packStatus: pack.status, currency: pack.identity.currency };
}

/** Crée uniquement la structure comptable et l'OWNER ; jamais de tiers ni d'écritures. */
export async function createFirstOwner(
  db: Db,
  raw: FirstOwnerInput,
  confirmedDatabase: string,
): Promise<{ organizationId: string; companyId: string; userId: string; created: boolean }> {
  const input = validateFirstOwnerInput(raw);
  // Sérialise deux bootstraps concurrents. La vérification ET toutes les
  // insertions sont dans la même transaction : aucun dossier sans OWNER.
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(19021, 1)`;
    const preview = await previewFirstOwner(tx as unknown as Db, input);
    if (!confirmedDatabase || confirmedDatabase !== preview.database) {
      throw new Error(`Confirmez explicitement la base cible avec --confirm-db ${preview.database}.`);
    }
    if (preview.existing) return { ...preview.existing, created: false };
    const pack = loadPack(input.country);
    if (!pack.identity.accounting_systems.includes("NORMAL")) {
      throw new Error(`Le pack ${input.country} ne prend pas en charge le système NORMAL.`);
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`
      INSERT INTO organization (id, name, kind, plan, mfa_required)
      VALUES (${organizationId}, ${input.organization}, ${input.kind}, 'TRIAL', ${input.kind === "FIRM"})`;
    await tx`
      INSERT INTO app_user (id, organization_id, email, display_name, locale)
      VALUES (${userId}, ${organizationId}, ${input.email}, ${input.name}, 'fr')`;
    const [company] = await tx`
      INSERT INTO company (organization_id, name, country_code, currency, accounting_system, pack_version)
      VALUES (${organizationId}, ${input.company}, ${input.country.toUpperCase()}, ${pack.identity.currency}, 'NORMAL', ${preview.packVersion})
      RETURNING id`;
    const companyId = String(company!.id);
    await tx`SELECT set_config('app.tenant_id', ${companyId}, true)`;
    for (const account of resolveChart()) {
      await tx`
        INSERT INTO account (tenant_id, number, label, class, nature, lettrable, postable)
        VALUES (${companyId}, ${account.number}, ${account.label}, ${account.class}, ${account.nature}, ${account.lettrable}, ${account.postable})`;
    }
    for (const journal of DEFAULT_JOURNALS) {
      await tx`INSERT INTO journal (tenant_id, code, label, type) VALUES (${companyId}, ${journal.code}, ${journal.label}, ${journal.type})`;
    }
    for (const override of pack.chart_overrides) {
      const cls = Number(override.number[0]);
      await tx`
        INSERT INTO account (tenant_id, number, label, class, nature, lettrable, postable)
        VALUES (${companyId}, ${override.number}, ${override.label}, ${cls}, ${natureOfClass(cls)}, ${override.lettrable ?? false}, true)
        ON CONFLICT (tenant_id, number) DO UPDATE
        SET label = EXCLUDED.label,
            lettrable = ${override.lettrable === undefined ? tx`account.lettrable` : override.lettrable}`;
      await tx`
        UPDATE account SET postable = false
        WHERE tenant_id = ${companyId} AND number <> ${override.number} AND ${override.number} LIKE number || '%'`;
    }
    const startDate = `${input.year}-01-01`;
    const endDate = `${input.year}-12-31`;
    const [fy] = await tx`
      INSERT INTO fiscal_year (tenant_id, code, start_date, end_date)
      VALUES (${companyId}, ${String(input.year)}, ${startDate}, ${endDate}) RETURNING id`;
    for (const [start, end] of monthlyRanges(startDate, endDate)) {
      await tx`
        INSERT INTO period (tenant_id, fiscal_year_id, start_date, end_date)
        VALUES (${companyId}, ${fy!.id}, ${start}, ${end})`;
    }
    await tx`INSERT INTO company_member (company_id, user_id, role) VALUES (${companyId}, ${userId}, 'OWNER')`;
    await audit(tx, {
      tenantId: companyId, userId, action: "MEMBER_ADDED", entity: "company_member",
      entityId: `${companyId}:${userId}`, before: null, after: { role: "OWNER", source: "first-owner-bootstrap" },
    });
    return { organizationId, companyId, userId, created: true };
  }) as Promise<{ organizationId: string; companyId: string; userId: string; created: boolean }>;
}