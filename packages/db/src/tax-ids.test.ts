import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type Db } from "./client.js";
import { EnvKeyProvider, PayrollCrypto } from "./crypto.js";
import { decryptTaxId, decryptTaxIds, normalizeTaxId, PARTNER_TAX_ID_DOMAIN, tenantCipherIn } from "./tenant-keys.js";
import { seedCompany } from "./seed.js";
import { createTestDatabase } from "./testing.js";

/**
 * Identifiants fiscaux : index aveugle, et reprise des lignes existantes par
 * `scripts/encrypt-tax-ids.mts` — idempotente et rejouable.
 */
const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "encrypt-tax-ids.mts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

// Clé maître fixe : le script tourne dans un autre processus, il doit trouver
// la même que le test, sinon rien ne se déchiffre.
const MASTER_KEY = randomBytes(32);
const MASTER_KEY_B64 = MASTER_KEY.toString("base64");
const crypto = new PayrollCrypto(new EnvKeyProvider({ key: MASTER_KEY }));

const env = await createTestDatabase();
const run = env ? describe : describe.skip;

let db: Db;
let orgId: string;
let tenantA: string;
let tenantB: string;
let partnerA: string;
let employeeA: string;

function runScript(extra: Record<string, string> = {}) {
  return execFileAsync(TSX, [SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: env!.url, PAYROLL_ENCRYPTION_KEY: MASTER_KEY_B64, ...extra },
  });
}

beforeAll(async () => {
  if (!env) return;
  db = env.db;
  const [org] = await db`INSERT INTO organization (name) VALUES ('Identifiants') RETURNING id`;
  orgId = org!.id as string;
  const fiscalYear = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };
  tenantA = (await seedCompany(db, { organizationId: orgId, name: "A", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;
  tenantB = (await seedCompany(db, { organizationId: orgId, name: "B", countryCode: "CI", currency: "XOF", packVersion: "ci@2025.1", fiscalYear })).companyId;

  // État « avant reprise » : tout en clair, tel que le laissait le schéma 0001/0005.
  await db`UPDATE company SET tax_ids = ${db.json({ NCC: "CI-1234567-A", RCCM: "CI-ABJ-2020-B-1234" } as never)} WHERE id = ${tenantA}`;
  const [p] = await db`
    INSERT INTO partner (tenant_id, type, name, tax_id, collective_account)
    VALUES (${tenantA}, 'SUPPLIER', 'Fournisseur Bêta', 'CI-7654321-B', '401') RETURNING id`;
  partnerA = p!.id as string;
  await db`INSERT INTO partner (tenant_id, type, name, collective_account) VALUES (${tenantA}, 'CUSTOMER', 'Sans identifiant', '411')`;
  const [emp] = await db`
    INSERT INTO employee (tenant_id, partner_id, matricule, first_name, last_name, hire_date, base_salary_enc, tax_id)
    VALUES (${tenantA}, ${partnerA}, 'M001', 'Awa', 'Koné', '2024-06-01', 'v2:0:placeholder', 'CI-1111111-C') RETURNING id`;
  employeeA = emp!.id as string;
  // Dossier B : même identifiant que A, pour vérifier le cloisonnement de l'index.
  await db`INSERT INTO partner (tenant_id, type, name, tax_id, collective_account) VALUES (${tenantB}, 'SUPPLIER', 'Même NCC', 'CI-7654321-B', '401')`;
});

afterAll(async () => {
  await env?.drop();
});

describe("index aveugle", () => {
  it("normalise avant d'indexer : ponctuation et casse ne comptent pas", () => {
    expect(normalizeTaxId("CI-1234567-A")).toBe("CI1234567A");
    expect(normalizeTaxId(" ci 1234567 a ")).toBe("CI1234567A");
    expect(normalizeTaxId("CI/1234567.A")).toBe("CI1234567A");
  });

  it("est déterministe, cloisonné par domaine et par clé, et ne révèle pas la valeur", async () => {
    const { record } = await crypto.generateTenantKey(1);
    const cipher = await crypto.cipherFor([record]);
    const a = cipher.blindIndex(PARTNER_TAX_ID_DOMAIN, "CI1234567A");
    expect(cipher.blindIndex(PARTNER_TAX_ID_DOMAIN, "CI1234567A")).toBe(a);
    expect(cipher.blindIndex("employee.tax_id", "CI1234567A")).not.toBe(a);
    expect(cipher.blindIndex(PARTNER_TAX_ID_DOMAIN, "CI1234567B")).not.toBe(a);
    expect(a).not.toContain("CI1234567A");

    // Une autre clé de dossier donne un autre index pour la même valeur.
    const other = await crypto.cipherFor([(await crypto.generateTenantKey(1)).record]);
    expect(other.blindIndex(PARTNER_TAX_ID_DOMAIN, "CI1234567A")).not.toBe(a);

    // La rotation n'invalide pas l'index : il est dérivé de la plus ancienne version.
    const rotated = await crypto.cipherFor([{ ...record, status: "RETIRED" }, (await crypto.generateTenantKey(2)).record]);
    expect(rotated.blindIndex(PARTNER_TAX_ID_DOMAIN, "CI1234567A")).toBe(a);
    expect(rotated.activeVersion).toBe(2);
  });
});

run("reprise des identifiants fiscaux existants", () => {
  it("la simulation ne change rien", async () => {
    const { stdout } = await runScript({ DRY_RUN: "1" });
    expect(stdout).toContain("(simulation)");
    const [c] = await db`SELECT tax_ids, tax_ids_enc FROM company WHERE id = ${tenantA}`;
    expect(c!.tax_ids_enc).toBeNull();
    expect(c!.tax_ids).toEqual({ NCC: "CI-1234567-A", RCCM: "CI-ABJ-2020-B-1234" });
    expect(await db`SELECT count(*)::int AS n FROM payroll_tenant_key`).toEqual([{ n: 0 }]);
  });

  it("chiffre les lignes existantes et efface le clair", async () => {
    const { stdout } = await runScript();
    expect(stdout).toContain("2 dossier(s) traité(s)");

    const [c] = await db`SELECT tax_ids, tax_ids_enc FROM company WHERE id = ${tenantA}`;
    expect(c!.tax_ids).toEqual({});
    expect(String(c!.tax_ids_enc)).toMatch(/^v2:1:/);

    const [p] = await db`SELECT tax_id, tax_id_enc, tax_id_bidx FROM partner WHERE id = ${partnerA}`;
    expect(p!.tax_id).toBeNull();
    expect(String(p!.tax_id_enc)).toMatch(/^v2:1:/);
    expect(p!.tax_id_bidx).toBeTruthy();

    const [e] = await db`SELECT tax_id, tax_id_enc FROM employee WHERE id = ${employeeA}`;
    expect(e!.tax_id).toBeNull();
    expect(String(e!.tax_id_enc)).toMatch(/^v2:1:/);

    // Plus une seule valeur en clair dans les trois colonnes reprises.
    const leftovers = await db`
      SELECT (SELECT count(*)::int FROM partner WHERE tax_id IS NOT NULL) AS partners,
             (SELECT count(*)::int FROM employee WHERE tax_id IS NOT NULL) AS employees,
             (SELECT count(*)::int FROM company WHERE tax_ids <> '{}'::jsonb) AS companies`;
    expect(leftovers[0]).toEqual({ partners: 0, employees: 0, companies: 0 });

    // Et cela se relit avec la clé de données du dossier.
    const readBack = await withTenant(db, { tenantId: tenantA, organizationId: orgId }, async (tx) => {
      const cipher = await tenantCipherIn(tx, tenantA, crypto);
      const [company] = await tx`SELECT tax_ids_enc FROM company WHERE id = ${tenantA}`;
      const [partner] = await tx`SELECT tax_id_enc FROM partner WHERE id = ${partnerA}`;
      const [employee] = await tx`SELECT tax_id_enc FROM employee WHERE id = ${employeeA}`;
      return {
        taxIds: decryptTaxIds(cipher, company!.tax_ids_enc as string),
        partner: decryptTaxId(cipher, partner!.tax_id_enc as string),
        employee: decryptTaxId(cipher, employee!.tax_id_enc as string),
      };
    });
    expect(readBack.taxIds).toEqual({ NCC: "CI-1234567-A", RCCM: "CI-ABJ-2020-B-1234" });
    expect(readBack.partner).toBe("CI-7654321-B");
    expect(readBack.employee).toBe("CI-1111111-C");
  });

  it("deux dossiers portant le même identifiant ont deux index différents", async () => {
    const rows = await db`SELECT tenant_id, tax_id_bidx FROM partner WHERE tax_id_bidx IS NOT NULL ORDER BY tenant_id`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tax_id_bidx).not.toBe(rows[1]!.tax_id_bidx);
  });

  it("est rejouable : un second passage ne touche rien", async () => {
    const before = await db`SELECT id, tax_id_enc, tax_id_bidx FROM partner ORDER BY id`;
    const beforeCompany = await db`SELECT id, tax_ids_enc FROM company ORDER BY id`;
    const beforeKeys = await db`SELECT tenant_id, version FROM payroll_tenant_key ORDER BY tenant_id`;

    const { stdout } = await runScript();
    expect(stdout).toContain("Rien à faire");
    expect(stdout).toContain("0 dossier(s) traité(s)");

    expect(await db`SELECT id, tax_id_enc, tax_id_bidx FROM partner ORDER BY id`).toEqual(before);
    expect(await db`SELECT id, tax_ids_enc FROM company ORDER BY id`).toEqual(beforeCompany);
    // Aucune clé de données supplémentaire n'a été créée.
    expect(await db`SELECT tenant_id, version FROM payroll_tenant_key ORDER BY tenant_id`).toEqual(beforeKeys);
  });

  it("un reste en clair à côté d'un chiffré est effacé, jamais réécrit depuis le clair", async () => {
    // Simule une écriture applicative concurrente qui aurait laissé les deux.
    await db`UPDATE partner SET tax_id = 'VALEUR-OBSOLETE' WHERE id = ${partnerA}`;
    const [encRow] = await db`SELECT tax_id_enc FROM partner WHERE id = ${partnerA}`;
    const encBefore = encRow!.tax_id_enc as string;
    const { stdout } = await runScript();
    expect(stdout).toContain("1 reste(s) en clair effacé(s)");
    const [after] = await db`SELECT tax_id, tax_id_enc FROM partner WHERE id = ${partnerA}`;
    expect(after!.tax_id).toBeNull();
    expect(after!.tax_id_enc).toBe(encBefore);
  });
});
