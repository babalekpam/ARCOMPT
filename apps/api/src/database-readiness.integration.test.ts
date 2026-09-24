// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@arcompt/db/testing";
import { assertProductionDatabaseSecurity } from "./database-readiness.js";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;

afterAll(async () => {
  await env?.drop();
});

run("production database startup with a real restricted app login", () => {
  it("accepts the complete migrated security baseline", async () => {
    await expect(assertProductionDatabaseSecurity(env!.appDb)).resolves.toBeUndefined();
  });

  it("rejects a bare Publish policy on a protected table", async () => {
    await env!.db`DROP POLICY onboarding_bootstrap_access ON public.onboarding_bootstrap`;
    await env!.db`CREATE POLICY onboarding_bootstrap_access ON public.onboarding_bootstrap`;
    await expect(assertProductionDatabaseSecurity(env!.appDb)).rejects.toThrow(/onboarding_bootstrap_access/);
  });
});