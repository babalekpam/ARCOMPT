// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Chiffrement par enveloppe des champs sensibles d'un dossier — docs/SECURITY.md §7.
 *
 * Ce module vivait dans `packages/payroll`. Il est remonté ici sans changer une
 * ligne de cryptographie : les identifiants fiscaux (`company.tax_ids`,
 * `partner.tax_id`, `employee.tax_id`) doivent être chiffrés avec la **même**
 * machinerie que la paie, et `@arcompt/db` est le seul paquet dont dépendent
 * déjà tous ceux qui les lisent ou les écrivent (paie, facturation, portail,
 * fiscalité, API). Créer un paquet de plus aurait touché le lockfile ; faire
 * dépendre `invoicing` et `portal` de `@arcompt/payroll` aurait inversé le sens
 * des dépendances pour du chiffrement générique. `packages/payroll/src/crypto.ts`
 * n'est plus qu'un ré-export : il n'existe qu'une implémentation.
 *
 * Le format des chiffrés et les données authentifiées (AAD) sont inchangés
 * (`payroll:v2:<version>`) : tout ce qui est déjà en base reste lisible.
 *
 *  - Une clé de données AES-256 par dossier (tenant), stockée en base
 *    enveloppée (`payroll_tenant_key.wrapped_key`).
 *  - L'enveloppe est posée par un `KeyProvider` : aujourd'hui la clé maître de
 *    PAYROLL_ENCRYPTION_KEY (base64, 32 octets), demain un KMS sans changer le
 *    reste du module.
 *  - Les champs sont chiffrés en AES-256-GCM avec la clé de données :
 *    `v2:<version>:<base64(iv ‖ tag ‖ chiffré)>` (iv 12 octets, tag 16) ; la
 *    version de clé est liée au chiffré par les données authentifiées (AAD).
 *  - La rotation (`PayrollService.rotateTenantKey`) crée une nouvelle version
 *    ACTIVE et re-chiffre les champs ; les anciennes versions restent lisibles
 *    (RETIRED) tant qu'elles sont enveloppées.
 *  - `TenantCipher.blindIndex` dérive un index aveugle déterministe pour les
 *    recherches par égalité (identifiants fiscaux) — voir sa documentation.
 *
 * Sans clé maître, hors production, une clé de développement déterministe est
 * dérivée d'une constante avec un avertissement ; en production, son absence
 * est une erreur de configuration. Aucune valeur en clair n'est jamais journalisée.
 */

const FIELD_VERSION = "v2";
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;

export class PayrollCryptoError extends Error {
  override name = "PayrollCryptoError";
}

/** Le chiffré référence une version de clé absente du jeu chargé : le jeu est à recharger (rotation faite ailleurs). */
export class UnknownKeyVersionError extends PayrollCryptoError {
  override name = "UnknownKeyVersionError";
  constructor(readonly version: number) {
    super(`Champ chiffré avec la version de clé ${version}, indisponible dans le jeu chargé`);
  }
}

// -----------------------------------------------------------------------------
// Fournisseur de clé maître
// -----------------------------------------------------------------------------
/** Enveloppe et désenveloppe les clés de données. Remplaçable par un KMS. */
export interface KeyProvider {
  /** Identifiant stable de la clé maître (stocké avec chaque clé enveloppée pour la rotation de clé maître). */
  readonly id: string;
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string, masterKeyId: string): Promise<Buffer>;
}

export interface EnvKeyProviderOptions {
  /** Clé maître brute de 32 octets ; prioritaire sur la variable d'environnement. */
  key?: Buffer;
  env?: Record<string, string | undefined>;
  /** Journal des avertissements (défaut : console.warn). */
  warn?: (message: string) => void;
}

let devKeyWarned = false;

/** Résout la clé maître : option explicite, puis PAYROLL_ENCRYPTION_KEY, puis clé de dev hors production. */
export function resolveMasterKey(opts: EnvKeyProviderOptions = {}): Buffer {
  if (opts.key) {
    if (opts.key.length !== KEY_BYTES) throw new PayrollCryptoError(`Clé maître de paie : ${KEY_BYTES} octets attendus, reçu ${opts.key.length}`);
    return opts.key;
  }
  const env = opts.env ?? process.env;
  const encoded = env.PAYROLL_ENCRYPTION_KEY;
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== KEY_BYTES) {
      throw new PayrollCryptoError(`PAYROLL_ENCRYPTION_KEY : ${KEY_BYTES} octets attendus en base64, reçu ${key.length}`);
    }
    return key;
  }
  if (env.NODE_ENV === "production") {
    throw new PayrollCryptoError("PAYROLL_ENCRYPTION_KEY manquante : obligatoire en production");
  }
  if (!devKeyWarned) {
    devKeyWarned = true;
    (opts.warn ?? console.warn)("[payroll] PAYROLL_ENCRYPTION_KEY absente : clé maître de développement déterministe utilisée (jamais en production)");
  }
  return createHash("sha256").update("arcompt-payroll-dev-master-key").digest();
}

/** Clé maître en mémoire (variable d'environnement). L'enveloppe est un AES-256-GCM de la clé de données. */
export class EnvKeyProvider implements KeyProvider {
  private readonly master: Buffer;
  readonly id: string;

  constructor(opts: EnvKeyProviderOptions = {}) {
    this.master = resolveMasterKey(opts);
    // Empreinte publique de la clé : permet de savoir quelle clé maître a enveloppé une clé de données.
    this.id = `env:${createHash("sha256").update(this.master).digest("hex").slice(0, 16)}`;
  }

  async wrap(dataKey: Buffer): Promise<string> {
    if (dataKey.length !== KEY_BYTES) throw new PayrollCryptoError("Clé de données : longueur invalide");
    return `env:v1:${sealGcm(this.master, dataKey, Buffer.from(this.id)).toString("base64")}`;
  }

  async unwrap(wrapped: string, masterKeyId: string): Promise<Buffer> {
    if (masterKeyId !== this.id) throw new PayrollCryptoError(`Clé de données enveloppée par une autre clé maître (${masterKeyId})`);
    if (!wrapped.startsWith("env:v1:")) throw new PayrollCryptoError("Clé enveloppée : format inconnu");
    const key = openGcm(this.master, Buffer.from(wrapped.slice("env:v1:".length), "base64"), Buffer.from(this.id));
    if (key.length !== KEY_BYTES) throw new PayrollCryptoError("Clé de données désenveloppée : longueur invalide");
    return key;
  }
}

// -----------------------------------------------------------------------------
// Clés de données d'un dossier
// -----------------------------------------------------------------------------
export interface TenantKeyRecord {
  version: number;
  wrappedKey: string;
  masterKeyId: string;
  status: "ACTIVE" | "RETIRED";
}

/** Chiffre avec la version active, déchiffre avec la version indiquée dans le chiffré. */
export class TenantCipher {
  constructor(
    private readonly keys: Map<number, Buffer>,
    readonly activeVersion: number,
  ) {
    if (!keys.has(activeVersion)) throw new PayrollCryptoError(`Version de clé active ${activeVersion} absente`);
  }

  versions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  encrypt(plain: string): string {
    const key = this.keys.get(this.activeVersion)!;
    return `${FIELD_VERSION}:${this.activeVersion}:${sealGcm(key, Buffer.from(plain, "utf8"), aad(this.activeVersion)).toString("base64")}`;
  }

  decrypt(stored: string): string {
    const m = /^v2:(\d+):([A-Za-z0-9+/=]+)$/.exec(stored);
    if (!m) throw new PayrollCryptoError("Champ chiffré : format inconnu");
    const version = Number(m[1]);
    const key = this.keys.get(version);
    if (!key) throw new UnknownKeyVersionError(version);
    return openGcm(key, Buffer.from(m[2]!, "base64"), aad(version)).toString("utf8");
  }

  /** Version de clé utilisée par un chiffré (sans le déchiffrer). */
  static versionOf(stored: string): number | null {
    const m = /^v2:(\d+):/.exec(stored);
    return m ? Number(m[1]) : null;
  }

  /**
   * Index aveugle déterministe pour les recherches par égalité (identifiants
   * fiscaux) : HMAC-SHA-256 de la valeur normalisée, sous une clé dérivée par
   * HKDF de la clé de données du dossier.
   *
   * Deux propriétés voulues :
   *  - la base seule n'apprend rien : sans la clé maître, l'index n'est pas
   *    calculable, on ne peut donc pas tester un identifiant candidat ;
   *  - l'index est cloisonné par dossier et par domaine (`partner.tax_id`…) :
   *    deux dossiers portant le même NCC n'ont pas le même index.
   *
   * La clé d'index est dérivée de la **plus ancienne** version de clé du
   * dossier, jamais retirée de `payroll_tenant_key`. La rotation de la clé de
   * données re-chiffre les champs sans invalider les index : il n'y a pas de
   * fenêtre pendant laquelle une recherche ne trouve plus rien. Ce que l'index
   * concède — l'égalité de deux valeurs est observable — est le prix de la
   * recherche ; il est assumé ici et nulle part ailleurs.
   */
  blindIndex(domain: string, value: string): string {
    const base = this.keys.get(Math.min(...this.keys.keys()))!;
    const key = Buffer.from(hkdfSync("sha256", base, Buffer.from(`${FIELD_VERSION}:blind-index`), Buffer.from(domain, "utf8"), KEY_BYTES));
    return createHmac("sha256", key).update(value, "utf8").digest("base64");
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T = unknown>(stored: string): T {
    return JSON.parse(this.decrypt(stored)) as T;
  }
}

/** Fabrique et désenveloppe les clés de données via le fournisseur de clé maître. */
export class PayrollCrypto {
  readonly provider: KeyProvider;

  constructor(provider?: KeyProvider) {
    this.provider = provider ?? new EnvKeyProvider();
  }

  get masterKeyId(): string {
    return this.provider.id;
  }

  /** Génère une clé de données aléatoire et son enveloppe. */
  async generateTenantKey(version: number): Promise<{ record: TenantKeyRecord; key: Buffer }> {
    const key = randomBytes(KEY_BYTES);
    const wrappedKey = await this.provider.wrap(key);
    return { record: { version, wrappedKey, masterKeyId: this.provider.id, status: "ACTIVE" }, key };
  }

  /** Désenveloppe le jeu de clés d'un dossier (toutes les versions lisibles, une seule active). */
  async cipherFor(records: TenantKeyRecord[]): Promise<TenantCipher> {
    if (records.length === 0) throw new PayrollCryptoError("Aucune clé de données pour ce dossier");
    const keys = new Map<number, Buffer>();
    for (const r of records) keys.set(r.version, await this.provider.unwrap(r.wrappedKey, r.masterKeyId));
    const active = records.filter((r) => r.status === "ACTIVE").sort((a, b) => b.version - a.version)[0];
    if (!active) throw new PayrollCryptoError("Aucune clé de données active pour ce dossier");
    return new TenantCipher(keys, active.version);
  }
}

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------
function aad(version: number): Buffer {
  return Buffer.from(`payroll:${FIELD_VERSION}:${version}`);
}

function sealGcm(key: Buffer, plain: Buffer, additional: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additional);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function openGcm(key: Buffer, raw: Buffer, additional: Buffer): Buffer {
  if (raw.length < IV_BYTES + TAG_BYTES) throw new PayrollCryptoError("Champ chiffré : données tronquées");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(additional);
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new PayrollCryptoError("Champ chiffré : authentification échouée (clé ou données invalides)");
  }
}

/** Masque une valeur sensible pour l'affichage aux rôles restreints : ne garde que les derniers caractères. */
export function maskSensitive(value: string | null | undefined, visible = 2): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length <= visible) return "*".repeat(s.length);
  return "*".repeat(Math.min(s.length - visible, 8)) + s.slice(-visible);
}
