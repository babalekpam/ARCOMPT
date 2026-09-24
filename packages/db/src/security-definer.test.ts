// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { provisionQueueRole } from "./provision.js";
import { createTestDatabase } from "./testing.js";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;

afterAll(async () => {
  await env?.drop();
});

const queueFunctions = new Set([
  "public.background_job_claim(text[])",
  "public.background_job_renew(uuid,uuid)",
  "public.background_job_finish(uuid,uuid,text)",
  "public.background_job_expire_reminders()",
]);

run("SECURITY DEFINER — qualified relation shadowing and catalog contract", () => {
  it("uses the actual restricted app login against a temporary shadow", async () => {
    const [org] = await env!.db`INSERT INTO public.organization (name) VALUES ('Shadow platform') RETURNING id`;
    const [user] = await env!.db`INSERT INTO public.app_user
      (organization_id, keycloak_sub, email, display_name)
      VALUES (${org!.id}, 'shadow-platform-sub', 'shadow-platform@test.invalid', 'Shadow') RETURNING id`;
    const [company] = await env!.db`INSERT INTO public.company
      (organization_id, name, country_code, currency, pack_version)
      VALUES (${org!.id}, 'Shadow company', 'CI', 'XOF', 'ci@test') RETURNING id`;
    await env!.db`INSERT INTO public.platform_admin (user_id) VALUES (${user!.id})`;

    await env!.appDb.begin(async (tx) => {
      await tx`CREATE TEMP TABLE platform_admin (user_id uuid, active boolean)`;
      await tx`INSERT INTO pg_temp.platform_admin VALUES (${user!.id}, false)`;
      const rows = await tx`SELECT * FROM public.platform_admin_company('shadow-platform-sub', ${company!.id})`;
      expect(rows).toEqual([{ company_id: company!.id, organization_id: org!.id }]);
    });
  });

  it("uses a provisioned restricted queue login against a temporary shadow", async () => {
    const login = `arcompt_q_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const password = `queue-${randomUUID()}-secure`;
    await provisionQueueRole(env!.db, { login, password });
    const [org] = await env!.db`INSERT INTO public.organization (name) VALUES ('Shadow queue') RETURNING id`;
    const [company] = await env!.db`INSERT INTO public.company
      (organization_id, name, country_code, currency, pack_version)
      VALUES (${org!.id}, 'Queue company', 'CI', 'XOF', 'ci@test') RETURNING id`;
    const [job] = await env!.db`INSERT INTO public.background_job
      (tenant_id, name, payload) VALUES (${company!.id}, 'document.extract', '{}'::jsonb) RETURNING id`;
    const url = new URL(env!.url);
    url.username = login;
    url.password = password;
    const queueDb = createDb({ url: url.toString(), max: 1 });
    try {
      await queueDb.begin(async (tx) => {
        await tx`CREATE TEMP TABLE background_job (id uuid, status text, name text, run_at timestamptz)`;
        await tx`INSERT INTO pg_temp.background_job VALUES (${job!.id}, 'PENDING', 'document.extract', now())`;
        const rows = await tx`SELECT id FROM public.background_job_claim(ARRAY['document.extract'])`;
        expect(rows).toEqual([{ id: job!.id }]);
      });
    } finally {
      await queueDb.end();
    }
  });

  it("keeps the complete 0028 SECURITY DEFINER and EXECUTE grant contract", async () => {
    const expected = [
      ["public.platform_admin_company(text,uuid)", true],
      ["public.platform_admin_companies(text)", true],
      ["public.platform_admin_record_access(text,uuid,text,text)", true],
      ["public.background_job_claim(text[])", false],
      ["public.background_job_renew(uuid,uuid)", false],
      ["public.background_job_finish(uuid,uuid,text)", false],
      ["public.background_job_expire_reminders()", false],
      ["public.background_job_retry_internal(uuid)", true],
      ["public.background_job_review_reminder(uuid,uuid,text)", true],
      ["public.auth_resolve_identity(text)", true],
      ["public.auth_link_subject(text,text)", true],
      ["public.auth_touch_last_active(uuid)", true],
      ["public.organization_of_company(uuid)", true],
      ["public.invitation_by_token_hash(text)", true],
      ["public.portal_dashboard(uuid)", true],
      ["public.whatsapp_resolve_phone(text)", true],
      ["public.payment_link_resolve(text,text)", true],
    ] as const;
    const oidList = expected.map(([signature]) => `to_regprocedure('${signature}')`).join(", ");
    const rows = await env!.db.unsafe(`
      SELECT p.oid::regprocedure::text AS signature, p.prosecdef,
             p.proconfig, pg_get_userbyid(p.proowner) AS owner,
             pg_get_userbyid(n.nspowner) AS schema_owner,
             current_user AS expected_owner,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
             has_function_privilege('arcompt_app', p.oid, 'EXECUTE') AS app_execute,
             has_function_privilege('arcompt_queue', p.oid, 'EXECUTE') AS queue_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.oid IN (${oidList})
       ORDER BY signature`);
    expect(rows).toHaveLength(expected.length);
    for (const row of rows) {
      const normalized = row.signature.replace(/^public\./, "").replace(/\s/g, "");
      const wanted = expected.find(([signature]) =>
        signature.replace(/^public\./, "").replace(/\s/g, "") === normalized);
      expect(wanted).toBeDefined();
      expect(row.prosecdef).toBe(true);
      // The migration runner owns the functions.  On PostgreSQL 15+, the
      // public schema owner is the virtual pg_database_owner role, so compare
      // against the actual schema migration owner rather than that alias.
      expect(row.owner).toBe(row.expected_owner);
      expect(row.proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(row.public_execute).toBe(false);
      expect(row.app_execute).toBe(wanted![1]);
      expect(row.queue_execute).toBe([...queueFunctions].some((signature) =>
        signature.replace(/^public\./, "").replace(/\s/g, "") === normalized));
    }
  });
});