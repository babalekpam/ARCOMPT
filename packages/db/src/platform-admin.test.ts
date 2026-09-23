// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./testing.js";

/**
 * These tests run in a disposable database.  The assertions which create an
 * administrator and an audit row are enclosed in a transaction and rolled
 * back; the database itself is dropped as a second isolation boundary.
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

afterAll(async () => {
  await env?.drop();
});

run("platform administrator — SQL boundary", () => {
  it("exposes only active principals and the API-selected companies", async () => {
    const db = env!.db;
    await db.begin(async (tx) => {
      const [org] = await tx`INSERT INTO organization (name) VALUES ('Platform test') RETURNING id`;
      const [user] = await tx`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name)
        VALUES (${org!.id}, 'clerk_platform_test', 'platform@test.invalid', 'Platform test') RETURNING id`;
      const [company] = await tx`INSERT INTO company
        (organization_id, name, country_code, currency, pack_version)
        VALUES (${org!.id}, 'Selected company', 'CI', 'XOF', 'ci@test') RETURNING id`;
      await tx`INSERT INTO platform_admin (user_id) VALUES (${user!.id})`;

      // Simulate the restricted application connection.  The functions retain
      // their definer privileges, while direct table access remains forbidden.
      await tx`SET LOCAL ROLE arcompt_app`;
      const identity = await tx`SELECT * FROM platform_admin_identity('clerk_platform_test')`;
      expect(identity).toHaveLength(1);
      expect(identity[0]!.user_id).toBe(user!.id);
      expect(identity[0]!.suspended_at).toBeNull();

      expect(await tx`SELECT * FROM platform_admin_identity('other-sub')`).toHaveLength(0);
      expect(await tx`SELECT * FROM platform_admin_company('clerk_platform_test', ${company!.id})`)
        .toEqual([{ company_id: company!.id, organization_id: org!.id }]);
      expect((await tx`SELECT company_id, company_name, organization_id, organization_name, country_code
        FROM platform_admin_companies('clerk_platform_test')`)).toEqual([
        { company_id: company!.id, company_name: "Selected company", organization_id: org!.id,
          organization_name: "Platform test", country_code: "CI" },
      ]);
      await tx`SELECT platform_admin_record_access('clerk_platform_test', ${company!.id}, 'GET', '/companies/selected')`;
      await tx`RESET ROLE`;

      const audit = await tx`SELECT actor_user_id, company_id, organization_id, method, path, event
        FROM platform_admin_audit`;
      expect(audit).toEqual([{
        actor_user_id: user!.id, company_id: company!.id, organization_id: org!.id,
        method: "GET", path: "/companies/selected", event: "ACCESS",
      }]);
      const [privileges] = await tx`SELECT has_table_privilege('arcompt_app', 'platform_admin', 'SELECT') AS admin_read,
        has_table_privilege('arcompt_app', 'platform_admin_audit', 'INSERT') AS audit_insert`;
      expect(privileges).toEqual({ admin_read: false, audit_insert: false });
      const [immutable] = await tx`SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgrelid = 'platform_admin_audit'::regclass AND tgname = 'platform_admin_audit_immutable'`;
      expect(immutable!.n).toBe(1);
    });
  });

  it("rejects suspended principals and records no access for them", async () => {
    const db = env!.db;
    let error: unknown;
    try {
      await db.begin(async (tx) => {
      const [org] = await tx`INSERT INTO organization (name) VALUES ('Suspended test') RETURNING id`;
      const [user] = await tx`INSERT INTO app_user (organization_id, keycloak_sub, email, display_name)
        VALUES (${org!.id}, 'clerk_suspended_test', 'suspended@test.invalid', 'Suspended test') RETURNING id`;
      await tx`INSERT INTO platform_admin (user_id) VALUES (${user!.id})`;
      await tx`UPDATE app_user SET suspended_at = now() WHERE id = ${user!.id}`;
      await tx`SET LOCAL ROLE arcompt_app`;
      expect(await tx`SELECT * FROM platform_admin_identity('clerk_suspended_test')`).toHaveLength(0);
        await tx`SELECT platform_admin_record_access('clerk_suspended_test', NULL, 'GET', '/companies')`;
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "28000" });
  });
});