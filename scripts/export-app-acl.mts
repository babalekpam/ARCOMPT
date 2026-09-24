// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Export the explicit ACL entries for arcompt_app from the development
 * catalog.  This intentionally reads pg_catalog only: no accounting table is
 * opened, and the only write is the local manifest produced by the caller.
 *
 *   pnpm exec tsx scripts/export-app-acl.mts
 *
 * DATABASE_URL must point at the fully migrated development database.  The
 * generated file is a declarative snapshot, not a migration: default ACLs are
 * deliberately not represented here.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb } from "../packages/db/src/client.js";

const ROLE = "arcompt_app";
export const MANIFEST_PATH = "docs/PRIVATE-PUBLISH-APP-GRANTS.sql";

export interface AclRow {
  kind: "TABLE" | "SEQUENCE";
  schemaName: string;
  objectName: string;
  privilege: string;
  grantable: boolean;
  columnName?: string | null;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Render rows returned by the catalog query. Empty column names are ignored:
 * dropped columns can remain represented by catalog ACL data while no valid
 * GRANT target exists for them.
 */
export function renderAclManifest(rows: readonly AclRow[]): string {
  const statements = rows
    .filter((row) => row.columnName === undefined || row.columnName === null || row.columnName.length > 0)
    .map((row) => {
      const target = `${quoteIdentifier(row.schemaName)}.${quoteIdentifier(row.objectName)}`;
      const column = row.columnName ? ` (${quoteIdentifier(row.columnName)})` : "";
      const grantOption = row.grantable ? " WITH GRANT OPTION" : "";
      return `GRANT ${row.privilege}${column} ON ${row.kind} ${target} TO ${quoteIdentifier(ROLE)}${grantOption};`;
    });

  statements.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    "-- Generated from the development pg_catalog; explicit grants only.",
    "-- Default ACLs are intentionally excluded and must be asserted absent separately.",
    `-- Role: ${ROLE}`,
    "",
    ...statements,
    "",
  ].join("\n");
}

function assertDevelopmentTarget(databaseUrl: string): void {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error("Refus d'export ACL : environnement de production");
  }
  const database = (() => {
    try {
      return new URL(databaseUrl).pathname.replace(/^\/+/, "").split(/[?/#]/, 1)[0] ?? "";
    } catch {
      return "";
    }
  })().toLowerCase();
  if (/(^|[-_])(prod|production)([-_]|$)/.test(database)) {
    throw new Error("Refus d'export ACL : DATABASE_URL ressemble à une base de production");
  }
}

export async function exportAppAcl(databaseUrl = process.env.DATABASE_URL): Promise<string> {
  if (!databaseUrl) throw new Error("DATABASE_URL manquant (la base de développement est requise)");
  assertDevelopmentTarget(databaseUrl);
  const db = createDb({ url: databaseUrl, max: 1 });
  try {
    // aclexplode is used only on explicit ACL arrays. NULL means no explicit
    // ACL and therefore must not be mistaken for a grant to the application.
    const rows = await db<AclRow[]>`
      SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS "kind",
             n.nspname AS "schemaName", c.relname AS "objectName",
             acl.privilege_type AS "privilege", acl.is_grantable AS "grantable",
             NULL::text AS "columnName"
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_roles app ON app.rolname = ${ROLE}
        CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND acl.grantee = app.oid
      UNION ALL
      SELECT 'TABLE' AS "kind", n.nspname AS "schemaName", c.relname AS "objectName",
             acl.privilege_type AS "privilege", acl.is_grantable AS "grantable",
             a.attname AS "columnName"
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_roles app ON app.rolname = ${ROLE}
        JOIN pg_catalog.pg_attribute a
          ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND acl.grantee = app.oid
    `;
    const defaults = await db<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_default_acl d
          CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl
          JOIN pg_catalog.pg_roles app ON app.rolname = ${ROLE}
         WHERE acl.grantee = app.oid
      ) AS present
    `;
    if (defaults[0]?.present) {
      throw new Error("ACL par défaut présent pour arcompt_app : migration de révocation requise");
    }
    const manifest = renderAclManifest(rows);
    await writeFile(resolve(MANIFEST_PATH), manifest, "utf8");
    return manifest;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const manifest = await exportAppAcl();
    console.log(`✓ manifeste ACL écrit dans ${MANIFEST_PATH} (${manifest.split("\n").filter((line) => line.startsWith("GRANT ")).length} GRANTs)`);
  } catch (error) {
    console.error(`✗ export ACL impossible : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    process.exitCode = 1;
  }
}