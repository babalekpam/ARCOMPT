// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Clé de données d'un dossier et champs chiffrés partagés.
 *
 * `payroll_tenant_key` porte la clé de données (enveloppée) d'un dossier. Elle
 * servait à la seule paie ; elle sert désormais aussi aux identifiants fiscaux
 * — `company.tax_ids`, `partner.tax_id`, `employee.tax_id` — que
 * `docs/SECURITY.md` §7 promet de chiffrer au niveau applicatif. Une seule clé
 * par dossier, un seul schéma de chiffrement, une seule rotation.
 *
 * Le nom de la table reste `payroll_tenant_key` : la renommer aurait touché
 * `0005_payroll.sql` et cassé la lecture des champs de paie existants pour
 * aucun gain.
 *
 * Migration en deux temps (une migration ne peut pas détenir la clé) :
 *  1. `0011_pack_status_tax_ids.sql` ajoute les colonnes `*_enc` et l'index
 *     aveugle, sans toucher aux valeurs ;
 *  2. `scripts/encrypt-tax-ids.mts` chiffre les lignes existantes et efface le
 *     clair, idempotent et rejouable.
 *
 * Tant que les deux temps ne sont pas passés, les lecteurs acceptent encore la
 * colonne en clair (`decryptTaxId(cipher, enc, clair)`) : un déploiement qui a
 * migré le schéma mais pas encore lancé le script continue de fonctionner.
 */

import type { Sql } from "postgres";
import { withTenant, type Db } from "./client.js";
import { PayrollCrypto, TenantCipher, type TenantKeyRecord } from "./crypto.js";

export interface TenantKeyContext {
  tenantId: string;
  userId?: string;
  organizationId?: string;
}

/** Domaines d'index aveugle : cloisonnent l'index par colonne. */
export const PARTNER_TAX_ID_DOMAIN = "partner.tax_id";

/** Lit le jeu de clés d'un dossier dans une transaction déjà ouverte (RLS posée). */
export async function loadTenantKeys(tx: Sql, tenantId: string): Promise<TenantKeyRecord[]> {
  const rows = await tx`SELECT version, wrapped_key, master_key_id, status FROM payroll_tenant_key WHERE tenant_id = ${tenantId} ORDER BY version`;
  return rows.map((r) => ({ version: Number(r.version), wrappedKey: r.wrapped_key as string, masterKeyId: r.master_key_id as string, status: r.status as TenantKeyRecord["status"] }));
}

/**
 * Jeu de clés du dossier, désenveloppé ; créé à la première utilisation.
 * Deux requêtes concurrentes peuvent créer la première clé : l'unicité
 * (tenant, version) tranche, on relit.
 */
export async function tenantCipherIn(tx: Sql, tenantId: string, crypto: PayrollCrypto = new PayrollCrypto()): Promise<TenantCipher> {
  let records = await loadTenantKeys(tx, tenantId);
  if (records.length === 0) {
    const { record } = await crypto.generateTenantKey(1);
    await tx`
      INSERT INTO payroll_tenant_key (tenant_id, version, wrapped_key, master_key_id, status)
      VALUES (${tenantId}, ${record.version}, ${record.wrappedKey}, ${record.masterKeyId}, 'ACTIVE')
      ON CONFLICT (tenant_id, version) DO NOTHING`;
    records = await loadTenantKeys(tx, tenantId);
  }
  return crypto.cipherFor(records);
}

/**
 * Jeu de clés du dossier **s'il existe déjà**, `null` sinon — sans rien créer.
 *
 * À utiliser sur les chemins de lecture : un dossier sans clé n'a par
 * construction aucun champ chiffré, il n'y a donc rien à déchiffrer et rien à
 * chercher par index aveugle. Créer une clé en lecture ferait écrire une
 * consultation et ferait apparaître des clés pour des dossiers qui n'en ont pas
 * l'usage.
 */
export async function existingTenantCipherIn(tx: Sql, tenantId: string, crypto: PayrollCrypto = new PayrollCrypto()): Promise<TenantCipher | null> {
  const records = await loadTenantKeys(tx, tenantId);
  return records.length === 0 ? null : crypto.cipherFor(records);
}

/** Même chose, en ouvrant sa propre transaction avec le contexte tenant (RLS). */
export async function tenantCipher(db: Db, ctx: TenantKeyContext, crypto?: PayrollCrypto): Promise<TenantCipher> {
  return withTenant(db, ctx, (tx) => tenantCipherIn(tx, ctx.tenantId, crypto));
}

// ---------------------------------------------------------------------------
// Identifiants fiscaux
// ---------------------------------------------------------------------------

/**
 * Normalisation avant index aveugle : majuscules, tout ce qui n'est ni lettre
 * ni chiffre retiré. « ci 1234567 a » et « CI-1234567-A » ont le même index —
 * la recherche par identifiant reste tolérante à la ponctuation, ce que le
 * `ILIKE` d'avant offrait aussi.
 */
export function normalizeTaxId(value: string): string {
  return value.normalize("NFKD").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** Chiffre un identifiant fiscal ; une valeur vide n'est pas chiffrée, elle est absente. */
export function encryptTaxId(cipher: TenantCipher | null, value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!cipher) throw new Error("Clé de données du dossier requise pour chiffrer un identifiant fiscal");
  return cipher.encrypt(v);
}

/**
 * Déchiffre un identifiant fiscal. `plain` est la colonne héritée en clair :
 * elle n'est lue que tant que le script de re-chiffrement n'est pas passé.
 */
export function decryptTaxId(cipher: TenantCipher | null, stored: string | null | undefined, plain?: string | null): string | null {
  if (stored) {
    if (!cipher) throw new Error("Identifiant fiscal chiffré sans clé de données pour ce dossier");
    return cipher.decrypt(stored);
  }
  return plain ?? null;
}

/** Index aveugle d'un identifiant fiscal ; `null` si la valeur est absente (rien à retrouver). */
export function taxIdBlindIndex(cipher: TenantCipher | null, domain: string, value: string | null | undefined): string | null {
  if (!cipher) return null;
  const v = value?.trim();
  if (!v) return null;
  const normalized = normalizeTaxId(v);
  return normalized ? cipher.blindIndex(domain, normalized) : null;
}

/** Chiffre la carte d'identifiants fiscaux d'un dossier (`company.tax_ids`). */
export function encryptTaxIds(cipher: TenantCipher, value: Record<string, string> | null | undefined): string | null {
  const entries = Object.entries(value ?? {}).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
  return entries.length === 0 ? null : cipher.encryptJson(Object.fromEntries(entries));
}

/** Déchiffre la carte d'identifiants fiscaux ; `plain` est la colonne jsonb héritée. */
export function decryptTaxIds(cipher: TenantCipher | null, stored: string | null | undefined, plain?: Record<string, unknown> | null): Record<string, string> {
  if (stored) {
    if (!cipher) throw new Error("Identifiants fiscaux chiffrés sans clé de données pour ce dossier");
    return cipher.decryptJson<Record<string, string>>(stored);
  }
  const entries = Object.entries(plain ?? {}).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
  return Object.fromEntries(entries) as Record<string, string>;
}
