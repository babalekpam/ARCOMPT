// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../packages/db/src/testing.js";
import { createFirstOwner, previewFirstOwner, validateFirstOwnerInput } from "./lib/bootstrap-owner.mjs";

const env = await createTestDatabase();
const run = env ? describe : describe.skip;
const input = {
  email: " FIRST.OWNER@example.test ",
  name: "Premier responsable",
  organization: "Cabinet initial",
  company: "Entreprise initiale",
  country: "CI",
  year: 2026,
  kind: "FIRM" as const,
};

afterAll(async () => {
  await env?.drop();
});

describe("validation du premier OWNER", () => {
  it("refuse une identité, un exercice ou un pack non valide", () => {
    expect(validateFirstOwnerInput(input).email).toBe("first.owner@example.test");
    expect(() => validateFirstOwnerInput({ ...input, email: "sans-email" })).toThrow();
    expect(() => validateFirstOwnerInput({ ...input, country: "../" })).toThrow();
    expect(() => validateFirstOwnerInput({ ...input, year: 2026.5 })).toThrow();
  });
});

run("création du premier OWNER sans démonstration", () => {
  it("exige le compte propriétaire et la confirmation de la base", async () => {
    await expect(previewFirstOwner(env!.appDb, input)).rejects.toThrow(/compte d'administration/);
    const preview = await previewFirstOwner(env!.db, input);
    expect(preview.existing).toBeUndefined();
    expect(preview.packVersion).toMatch(/^ci@/);
    await expect(createFirstOwner(env!.db, input, "mauvaise_base")).rejects.toThrow(/--confirm-db/);
    expect(await env!.db`SELECT count(*)::int AS n FROM organization WHERE name = ${input.organization}`).toEqual([{ n: 0 }]);
  });

  it("crée le dossier, l'OWNER et aucun tiers ou mouvement ; relance sans doublon", async () => {
    const { database } = await previewFirstOwner(env!.db, input);
    const created = await createFirstOwner(env!.db, input, database);
    expect(created.created).toBe(true);
    const [org] = await env!.db`SELECT kind, mfa_required FROM organization WHERE id = ${created.organizationId}`;
    expect(org).toMatchObject({ kind: "FIRM", mfa_required: true });
    const [member] = await env!.db`SELECT role FROM company_member WHERE company_id = ${created.companyId} AND user_id = ${created.userId}`;
    expect(member?.role).toBe("OWNER");
    const [counts] = await env!.db`
      SELECT (SELECT count(*)::int FROM account WHERE tenant_id = ${created.companyId}) AS accounts,
             (SELECT count(*)::int FROM fiscal_year WHERE tenant_id = ${created.companyId}) AS years,
             (SELECT count(*)::int FROM partner WHERE tenant_id = ${created.companyId}) AS partners,
             (SELECT count(*)::int FROM account_balance WHERE tenant_id = ${created.companyId}) AS balances,
             (SELECT count(*)::int FROM journal_entry WHERE tenant_id = ${created.companyId}) AS entries`;
    expect(Number(counts?.accounts)).toBeGreaterThan(0);
    expect(counts).toMatchObject({ years: 1, partners: 0, balances: 0, entries: 0 });
    expect(await createFirstOwner(env!.db, input, database)).toMatchObject({ ...created, created: false });
    await expect(previewFirstOwner(env!.db, { ...input, company: "Autre entreprise" })).rejects.toThrow(/autre configuration/);
    await expect(previewFirstOwner(env!.db, { ...input, email: "autre@example.test", organization: "Nouvelle organisation" }))
      .rejects.toThrow(/base contient déjà/);
  });

  it("annule intégralement une erreur après les premières insertions", async () => {
    const isolated = await createTestDatabase();
    if (!isolated) return;
    try {
      await isolated.db.unsafe(`
        CREATE FUNCTION fail_first_owner_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test rollback'; END $$;
        CREATE TRIGGER fail_first_owner_test BEFORE INSERT ON company_member
        FOR EACH ROW EXECUTE FUNCTION fail_first_owner_test();
      `);
      const { database } = await previewFirstOwner(isolated.db, input);
      await expect(createFirstOwner(isolated.db, input, database)).rejects.toThrow(/test rollback/);
      const [counts] = await isolated.db`
        SELECT (SELECT count(*)::int FROM organization) AS organizations,
               (SELECT count(*)::int FROM app_user) AS users,
               (SELECT count(*)::int FROM company) AS companies`;
      expect(counts).toMatchObject({ organizations: 0, users: 0, companies: 0 });
    } finally {
      await isolated.drop();
    }
  }, 15_000);

  it("ignore uniquement l'organisation interne dont tous les utilisateurs sont platform admins", async () => {
    const isolated = await createTestDatabase();
    if (!isolated) return;
    try {
      const [org] = await isolated.db`INSERT INTO organization (name, kind) VALUES ('__ARCOMPT_PLATFORM_INTERNAL__', 'GROUP') RETURNING id`;
      const [user] = await isolated.db`INSERT INTO app_user (organization_id, email, display_name)
        VALUES (${org!.id}, 'internal@example.test', 'Internal') RETURNING id`;
      await isolated.db`INSERT INTO platform_admin_reserved_org(organization_id) VALUES (${org!.id})`;
      await isolated.db`INSERT INTO platform_admin(user_id) VALUES (${user!.id})`;
      const preview = await previewFirstOwner(isolated.db, input);
      expect(preview.existing).toBeUndefined();
      const [bad] = await isolated.db`INSERT INTO app_user (organization_id, email, display_name)
        VALUES (${org!.id}, 'unrecorded@example.test', 'Unrecorded') RETURNING id`;
      await expect(previewFirstOwner(isolated.db, input)).rejects.toThrow(/base contient déjà/);
      await isolated.db`DELETE FROM app_user WHERE id = ${bad!.id}`;
    } finally {
      await isolated.drop();
    }
  }, 15_000);
});