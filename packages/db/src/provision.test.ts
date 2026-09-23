import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Ledger, PostgresStore, type Actor } from "@arcompt/ledger";
import { createDb, withTenant, type Db } from "./client.js";
import {
  APP_GROUP_ROLE,
  EXPECTED_APP_PRIVILEGES,
  ProvisionError,
  describeViolation,
  provisionAppRole,
  verifyAppPrivileges,
} from "./provision.js";
import { seedCompany } from "./seed.js";
import { createTestDatabase } from "./testing.js";

/**
 * Le modèle de droits du rôle applicatif, prouvé plutôt qu'affirmé.
 *
 * Deux niveaux, volontairement séparés :
 *  - `has_table_privilege` : ce que la base accorde, indépendamment de tout
 *    trigger. C'est la seule façon de prouver qu'un REVOKE tient toujours après
 *    l'ajout d'une migration (ALTER DEFAULT PRIVILEGES en avait annulé
 *    plusieurs sans bruit) ;
 *  - l'opération réelle, exécutée par un rôle de connexion provisionné ici :
 *    elle prouve que le refus se produit vraiment, et par quel mécanisme
 *    (droit SQL pour la clé de paie, trigger d'inaltérabilité pour une écriture
 *    validée).
 */
const env = await createTestDatabase();
const run = env ? describe : describe.skip;

const LOGIN = `arcompt_prov_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const PASSWORD = `pw-${randomUUID()}`;

let db: Db;
let appDb: Db;
let companyId: string;
let userId: string;
let orgId: string;
let clientId: string;
let actor: Actor;
let ledger: Ledger;

beforeAll(async () => {
  if (!env) return;
  db = env.db;

  const result = await provisionAppRole(db, { login: LOGIN, password: PASSWORD });
  expect(result.created).toBe(true);

  const url = new URL(env.url);
  url.username = LOGIN;
  url.password = PASSWORD;
  appDb = createDb({ url: url.toString(), max: 2 });

  const [org] = await db`INSERT INTO organization (name) VALUES ('Provision') RETURNING id`;
  orgId = org!.id as string;
  const [u] = await db`INSERT INTO app_user (organization_id, email, display_name) VALUES (${orgId}, 'p@p.p', 'P') RETURNING id`;
  userId = u!.id as string;
  companyId = (
    await seedCompany(db, {
      organizationId: orgId,
      name: "Dossier droits",
      countryCode: "TG",
      currency: "XOF",
      packVersion: "tg@2025.1",
      fiscalYear: { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
    })
  ).companyId;

  // Clé de paie enveloppée : c'est la donnée que l'application ne doit jamais
  // pouvoir détruire (sans elle, les colonnes *_enc sont perdues).
  await withTenant(db, { tenantId: companyId, organizationId: orgId }, (tx) =>
    tx`INSERT INTO payroll_tenant_key (tenant_id, version, wrapped_key, master_key_id) VALUES (${companyId}, 1, 'clé-enveloppée', 'env')`,
  );

  const [client] = await withTenant(db, { tenantId: companyId }, (tx) =>
    tx`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${companyId}, 'CUSTOMER', 'Client', '411') RETURNING id`,
  );
  clientId = client!.id as string;

  ledger = new Ledger(new PostgresStore(appDb as unknown as Sql, { userId, organizationId: orgId }), { baseCurrency: "XOF" });
  actor = { userId, tenantId: companyId };
});

afterAll(async () => {
  if (!env) return;
  await appDb?.end();
  // Les rôles sont globaux au cluster : on nettoie avant de supprimer la base.
  await db.unsafe(`DROP OWNED BY ${LOGIN}`).catch(() => undefined);
  await db.unsafe(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => undefined);
  await env.drop();
});

const entry = (ref: string) => ({
  journalCode: "VT",
  date: "2025-03-15",
  reference: ref,
  label: "Facture",
  source: "INVOICE" as const,
  lines: [
    { accountNumber: "411", debit: "1180000", partnerId: clientId },
    { accountNumber: "706", credit: "1000000" },
    { accountNumber: "443", credit: "180000" },
  ],
});

run("rôle applicatif — modèle de droits", () => {
  it("le groupe et le rôle de connexion respectent le modèle déclaré", async () => {
    for (const role of [APP_GROUP_ROLE, LOGIN]) {
      const verification = await verifyAppPrivileges(db, role);
      expect(verification.violations.map(describeViolation)).toEqual([]);
      expect(verification.ok).toBe(true);
      // Le modèle doit rester couvert en entier : aucune ligne « table absente ».
      expect(verification.observations).toHaveLength(EXPECTED_APP_PRIVILEGES.length);
      expect(verification.observations.filter((o) => o.actual === null)).toEqual([]);
    }
  });

  it("has_table_privilege : les interdits du schéma tiennent après toutes les migrations", async () => {
    const [row] = await db`
      SELECT has_table_privilege(${LOGIN}, 'payroll_tenant_key', 'DELETE') AS delete_payroll_key,
             has_table_privilege(${LOGIN}, 'payroll_tenant_key', 'SELECT') AS read_payroll_key,
             has_table_privilege(${LOGIN}, 'audit_log', 'UPDATE') AS update_audit,
             has_table_privilege(${LOGIN}, 'audit_log', 'DELETE') AS delete_audit,
             has_table_privilege(${LOGIN}, 'account_balance', 'UPDATE') AS update_balance,
             has_table_privilege(${LOGIN}, 'admin_access_log', 'DELETE') AS delete_admin_log,
             has_table_privilege(${LOGIN}, 'whatsapp_webhook_receipt', 'UPDATE') AS update_receipt,
             has_table_privilege(${LOGIN}, 'schema_migration', 'INSERT') AS write_migrations`;
    expect(row).toMatchObject({
      delete_payroll_key: false,
      read_payroll_key: true,
      update_audit: false,
      delete_audit: false,
      update_balance: false,
      delete_admin_log: false,
      update_receipt: false,
      write_migrations: false,
    });
  });

  it("aucun privilège par défaut ne réarme les droits sur les tables créées plus tard", async () => {
    // C'était la cause première : ALTER DEFAULT PRIVILEGES (fin de 0001)
    // réaccordait les quatre droits à chaque nouvelle table, annulant les
    // restrictions des migrations suivantes.
    const rows = await db`
      SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclacl::text AS acl
        FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
       WHERE n.nspname = 'public' AND d.defaclobjtype = 'r' AND array_to_string(d.defaclacl, ',') LIKE ${"%" + APP_GROUP_ROLE + "=%"}`;
    expect(rows).toEqual([]);

    await db.unsafe("CREATE TABLE privilege_probe (id int)");
    try {
      const [row] = await db`SELECT has_table_privilege(${LOGIN}, 'privilege_probe', 'INSERT') AS granted`;
      expect(row!.granted).toBe(false);
    } finally {
      await db.unsafe("DROP TABLE privilege_probe");
    }
  });
});

run("rôle applicatif — refus effectifs sur une connexion applicative", () => {
  it("ne peut pas supprimer la clé de paie d'un dossier (droit SQL refusé)", async () => {
    await expect(
      withTenant(appDb, { tenantId: companyId, organizationId: orgId }, (tx) => tx`DELETE FROM payroll_tenant_key WHERE tenant_id = ${companyId}`),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
    const [kept] = await withTenant(db, { tenantId: companyId }, (tx) => tx`SELECT count(*)::int AS n FROM payroll_tenant_key WHERE tenant_id = ${companyId}`);
    expect(kept!.n).toBe(1);
  });

  it("ne peut ni modifier ni supprimer une écriture validée, mais garde la main sur ses brouillons", async () => {
    const posted = await ledger.post(actor, entry("FAC-DROITS-1"));
    // Écriture validée : le refus vient des triggers d'inaltérabilité, le droit
    // de table restant nécessaire aux brouillons.
    await expect(
      withTenant(appDb, { tenantId: companyId }, (tx) => tx`UPDATE journal_entry SET label = 'falsifié' WHERE id = ${posted.id}`),
    ).rejects.toMatchObject({ code: "P0003" });
    await expect(
      withTenant(appDb, { tenantId: companyId }, (tx) => tx`DELETE FROM journal_entry WHERE id = ${posted.id}`),
    ).rejects.toMatchObject({ code: "P0003" });

    const draft = await ledger.createDraft(actor, { ...entry("FAC-DROITS-2"), journalCode: "OD", lines: [{ accountNumber: "521", debit: "10" }, { accountNumber: "571", credit: "10" }] });
    await withTenant(appDb, { tenantId: companyId }, (tx) => tx`DELETE FROM journal_entry WHERE id = ${draft.id}`);
    const [left] = await withTenant(db, { tenantId: companyId }, (tx) => tx`SELECT count(*)::int AS n FROM journal_entry WHERE id = ${draft.id}`);
    expect(left!.n).toBe(0);
  });

  it("ne peut ni réécrire la piste d'audit ni toucher aux soldes", async () => {
    await expect(
      withTenant(appDb, { tenantId: companyId }, (tx) => tx`UPDATE audit_log SET action = 'x' WHERE tenant_id = ${companyId}`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(appDb, { tenantId: companyId }, (tx) => tx`DELETE FROM audit_log WHERE tenant_id = ${companyId}`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(appDb, { tenantId: companyId }, (tx) => tx`UPDATE account_balance SET debit = 0 WHERE tenant_id = ${companyId}`),
    ).rejects.toMatchObject({ code: "42501" });
    // Les soldes restent lisibles : ils alimentent la balance et les états.
    const [balance] = await withTenant(appDb, { tenantId: companyId }, (tx) => tx`SELECT count(*)::int AS n FROM account_balance WHERE tenant_id = ${companyId}`);
    expect(balance!.n).toBeGreaterThan(0);
  });

  it("ne peut pas réécrire l'historique des migrations", async () => {
    await expect(appDb`SELECT count(*) FROM schema_migration`).rejects.toMatchObject({ code: "42501" });
  });
});

run("provisionnement du rôle de connexion", () => {
  it("est idempotent et sert aussi à la rotation du mot de passe", async () => {
    const again = await provisionAppRole(db, { login: LOGIN, password: `pw-${randomUUID()}` });
    expect(again.created).toBe(false);
    expect(again.memberOf).toBe(APP_GROUP_ROLE);
    expect(again.attributes).toMatchObject({ superuser: false, bypassRls: false, inherit: true, createRole: false, createDb: false });
    expect(again.privileges.ok).toBe(true);
    // Le mot de passe précédent ne doit plus ouvrir de session : on remet celui
    // qu'utilise le reste de la suite.
    const restored = await provisionAppRole(db, { login: LOGIN, password: PASSWORD });
    expect(restored.created).toBe(false);
  });

  it("refuse un nom de rôle douteux, un mot de passe faible et le rôle de groupe lui-même", async () => {
    await expect(provisionAppRole(db, { login: 'x"; DROP TABLE company; --', password: `pw-${randomUUID()}` })).rejects.toBeInstanceOf(ProvisionError);
    await expect(provisionAppRole(db, { login: LOGIN, password: "court" })).rejects.toBeInstanceOf(ProvisionError);
    await expect(provisionAppRole(db, { login: APP_GROUP_ROLE, password: `pw-${randomUUID()}` })).rejects.toBeInstanceOf(ProvisionError);
  });
});
