// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Chiffrement des identifiants fiscaux déjà en base — second temps de la
 * migration `0011_pack_status_tax_ids.sql`.
 *
 *   DATABASE_URL=postgres://<compte_des_migrations>@…/arcompt \
 *   PAYROLL_ENCRYPTION_KEY='<base64 de 32 octets>' \
 *   pnpm exec tsx scripts/encrypt-tax-ids.mts
 *
 * Pourquoi un script et pas la migration : une migration SQL ne détient pas la
 * clé maître, et ne doit pas la détenir. Le schéma (colonnes `*_enc`, index
 * aveugle) est posé par `0011` ; le chiffrement des lignes existantes est fait
 * ici, avec la même machinerie que la paie (`packages/db/src/crypto.ts`).
 *
 * Pour chaque dossier :
 *  - `company.tax_ids`  → `company.tax_ids_enc`, puis `tax_ids` remis à `{}` ;
 *  - `partner.tax_id`   → `partner.tax_id_enc` + `partner.tax_id_bidx` (index
 *                         aveugle de recherche), puis `tax_id` mis à NULL ;
 *  - `employee.tax_id`  → `employee.tax_id_enc`, puis `tax_id` mis à NULL.
 *
 * **Idempotent et rejouable.** Une ligne n'est traitée que si elle porte encore
 * une valeur en clair et pas de chiffré ; chaque ligne est réécrite en une
 * seule instruction (chiffré posé et clair effacé ensemble), il n'y a donc pas
 * d'état intermédiaire à rattraper. Une ligne qui porte les deux — cas d'une
 * écriture applicative concurrente — voit seulement son clair effacé : le
 * chiffré fait foi, on ne le réécrit jamais depuis le clair. Un second passage
 * ne touche rien et affiche 0.
 *
 * Aucune valeur en clair n'est journalisée : seuls des compteurs sortent.
 *
 * Options (variables d'environnement) :
 *   DRY_RUN=1   compte ce qui serait fait, n'écrit rien.
 */
import { createDb, withTenant } from "../packages/db/src/client.js";
import { PayrollCrypto } from "../packages/db/src/crypto.js";
import { encryptTaxId, encryptTaxIds, PARTNER_TAX_ID_DOMAIN, taxIdBlindIndex, tenantCipherIn } from "../packages/db/src/tenant-keys.js";

interface Counters {
  companies: number;
  companyTaxIds: number;
  partners: number;
  employees: number;
  /** Lignes qui portaient déjà un chiffré : seul le clair résiduel est effacé. */
  plaintextCleared: number;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL manquant : il doit pointer le compte qui applique les migrations.");

const dryRun = /^(1|true|yes)$/i.test((process.env.DRY_RUN ?? "").trim());
const db = createDb({ url, max: 1 });
const crypto = new PayrollCrypto();
const total: Counters = { companies: 0, companyTaxIds: 0, partners: 0, employees: 0, plaintextCleared: 0 };

try {
  // Les tables portent `FORCE ROW LEVEL SECURITY` : même le propriétaire du
  // schéma ne voit que les lignes de son contexte tenant. Énumérer tous les
  // dossiers suppose donc un compte qui contourne la RLS — celui des
  // migrations, jamais `arcompt_app_login`.
  const [role] = await db`SELECT rolsuper OR rolbypassrls AS can_bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.can_bypass) {
    fail(
      "Le compte de DATABASE_URL ne contourne pas la RLS : il ne verrait aucun dossier et le script n'aurait rien à faire, en silence. " +
        "Relancez avec le compte qui applique les migrations (propriétaire du schéma / superutilisateur), pas avec le rôle applicatif.",
    );
  }

  const companies = await db`SELECT id, organization_id FROM company ORDER BY created_at, id`;
  for (const row of companies) {
    const companyId = row.id as string;
    const organizationId = row.organization_id as string;
    const counts = await withTenant(db, { tenantId: companyId, organizationId }, async (tx) => {
      const c: Omit<Counters, "companies"> = { companyTaxIds: 0, partners: 0, employees: 0, plaintextCleared: 0 };

      const [company] = await tx`SELECT tax_ids, tax_ids_enc FROM company WHERE id = ${companyId}`;
      const plainTaxIds = Object.entries((company?.tax_ids as Record<string, unknown> | null) ?? {}).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
      const companyNeedsWork = plainTaxIds.length > 0 && !company?.tax_ids_enc;
      const companyResidue = plainTaxIds.length > 0 && Boolean(company?.tax_ids_enc);

      const partners = await tx`SELECT id, tax_id FROM partner WHERE tenant_id = ${companyId} AND tax_id IS NOT NULL AND tax_id_enc IS NULL`;
      const employees = await tx`SELECT id, tax_id FROM employee WHERE tenant_id = ${companyId} AND tax_id IS NOT NULL AND tax_id_enc IS NULL`;
      const residuePartners = await tx`SELECT count(*)::int AS n FROM partner WHERE tenant_id = ${companyId} AND tax_id IS NOT NULL AND tax_id_enc IS NOT NULL`;
      const residueEmployees = await tx`SELECT count(*)::int AS n FROM employee WHERE tenant_id = ${companyId} AND tax_id IS NOT NULL AND tax_id_enc IS NOT NULL`;
      const residue = Number(residuePartners[0]?.n ?? 0) + Number(residueEmployees[0]?.n ?? 0) + (companyResidue ? 1 : 0);

      if (!companyNeedsWork && partners.length === 0 && employees.length === 0 && residue === 0) return c;
      c.companyTaxIds = companyNeedsWork ? 1 : 0;
      c.partners = partners.length;
      c.employees = employees.length;
      c.plaintextCleared = residue;
      if (dryRun) return c;

      // La clé de données du dossier n'est créée qu'ici, et seulement s'il y a
      // quelque chose à chiffrer : un dossier vide n'accumule pas de clé.
      const cipher = await tenantCipherIn(tx, companyId, crypto);

      if (companyNeedsWork) {
        const enc = encryptTaxIds(cipher, Object.fromEntries(plainTaxIds) as Record<string, string>);
        await tx`UPDATE company SET tax_ids_enc = ${enc}, tax_ids = '{}'::jsonb WHERE id = ${companyId}`;
      }
      for (const p of partners) {
        const value = p.tax_id as string;
        await tx`
          UPDATE partner SET tax_id_enc = ${encryptTaxId(cipher, value)}, tax_id_bidx = ${taxIdBlindIndex(cipher, PARTNER_TAX_ID_DOMAIN, value)}, tax_id = NULL
          WHERE tenant_id = ${companyId} AND id = ${p.id as string}`;
      }
      for (const e of employees) {
        await tx`UPDATE employee SET tax_id_enc = ${encryptTaxId(cipher, e.tax_id as string)}, tax_id = NULL, updated_at = now() WHERE tenant_id = ${companyId} AND id = ${e.id as string}`;
      }
      // Résidus : le chiffré fait foi, on n'efface que le clair.
      if (companyResidue) await tx`UPDATE company SET tax_ids = '{}'::jsonb WHERE id = ${companyId}`;
      await tx`UPDATE partner SET tax_id = NULL WHERE tenant_id = ${companyId} AND tax_id IS NOT NULL AND tax_id_enc IS NOT NULL`;
      await tx`UPDATE employee SET tax_id = NULL WHERE tenant_id = ${companyId} AND tax_id IS NOT NULL AND tax_id_enc IS NOT NULL`;
      return c;
    });

    if (counts.companyTaxIds || counts.partners || counts.employees || counts.plaintextCleared) {
      total.companies += 1;
      total.companyTaxIds += counts.companyTaxIds;
      total.partners += counts.partners;
      total.employees += counts.employees;
      total.plaintextCleared += counts.plaintextCleared;
      console.log(`  dossier ${companyId} : ${counts.companyTaxIds} identité dossier, ${counts.partners} tiers, ${counts.employees} salariés, ${counts.plaintextCleared} clair résiduel effacé`);
    }
  }

  const prefix = dryRun ? "(simulation) " : "";
  console.log(
    `${prefix}✓ ${total.companies} dossier(s) traité(s) sur ${companies.length} : ` +
      `${total.companyTaxIds} company.tax_ids, ${total.partners} partner.tax_id, ${total.employees} employee.tax_id chiffrés, ` +
      `${total.plaintextCleared} reste(s) en clair effacé(s).`,
  );
  if (total.companies === 0) console.log(`${prefix}Rien à faire : tous les identifiants fiscaux sont déjà chiffrés.`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.end();
}
