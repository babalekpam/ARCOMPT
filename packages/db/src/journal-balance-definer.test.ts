// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./testing.js";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;

afterAll(async () => {
  await env?.drop();
});

run("journal balance SECURITY DEFINER hardening", () => {
  it("uses qualified ledger relations and survives temporary relation shadowing", async () => {
    await env!.appDb.begin(async (tx) => {
      // A restricted caller can create temporary relations.  These names must
      // never intercept the trigger's writes or reads.
      await tx`CREATE TEMP TABLE account_balance (tenant_id uuid, account_id uuid, period_id uuid, debit numeric, credit numeric)`;
      await tx`CREATE TEMP TABLE journal_line (entry_id uuid, account_id uuid, debit numeric, credit numeric)`;

      const rows = await tx`
        SELECT p.prosecdef, p.proconfig,
               has_function_privilege(current_user, p.oid, 'EXECUTE') AS app_execute,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
               pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p
         WHERE p.oid = 'public.journal_entry_update_balances()'::regprocedure
      `;
      expect(rows).toHaveLength(1);
      const fn = rows[0]!;
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(fn.app_execute).toBe(false);
      expect(fn.public_execute).toBe(false);
      expect(fn.definition).toContain("public.account_balance");
      expect(fn.definition).toContain("public.journal_line");
    });
  });
});