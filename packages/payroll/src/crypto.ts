/**
 * Chiffrement par enveloppe : ré-export de l'implémentation unique.
 *
 * Le module vit désormais dans `packages/db/src/crypto.ts`. Les identifiants
 * fiscaux (`company.tax_ids`, `partner.tax_id`, `employee.tax_id`) doivent être
 * chiffrés avec la même machinerie que la paie, et ils sont lus ou écrits par
 * `@arcompt/invoicing`, `@arcompt/portal`, `@arcompt/tax` et l'API — qui
 * dépendent tous de `@arcompt/db`, mais pas de `@arcompt/payroll`.
 *
 * Ce fichier ne garde que la surface publique historique du module de paie :
 * le format des chiffrés, les noms et le comportement sont inchangés.
 */
export {
  EnvKeyProvider,
  KEY_BYTES,
  PayrollCrypto,
  PayrollCryptoError,
  TenantCipher,
  UnknownKeyVersionError,
  maskSensitive,
  resolveMasterKey,
  type EnvKeyProviderOptions,
  type KeyProvider,
  type TenantKeyRecord,
} from "@arcompt/db";
