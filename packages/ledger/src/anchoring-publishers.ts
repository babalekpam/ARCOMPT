/**
 * Publieurs d'ancres : ce qui fait réellement sortir la preuve de la plateforme.
 *
 * Deux implémentations réelles, choisies pour qu'un auditeur puisse contrôler
 * une ancre **sans nous** :
 *
 *  - `Rfc3161AnchorPublisher` — horodatage par une autorité tierce. C'est le
 *    seul qui atteste une *date* opposable : le jeton est signé par la TSA,
 *    vérifiable avec sa chaîne de certification publique, des années après.
 *  - `SignedEndpointAnchorPublisher` — le reçu d'ancre, signé Ed25519, déposé
 *    sur un point de collecte tenu par l'exploitant ou le commissaire aux
 *    comptes. La signature prouve l'origine et l'intégrité ; la date, elle,
 *    n'est attestée que par le registre du destinataire. Plus simple à mettre
 *    en place, strictement moins fort. À réserver au cas où aucune TSA n'est
 *    disponible.
 *
 * Et `MemoryAnchorPublisher` (dans `anchoring.ts`), réservé aux tests : il ne
 * publie rien, donc il est refusé en production.
 *
 * Règle de configuration, identique au reste du produit : variable absente =
 * fonction coupée et annoncée comme dégradée, jamais simulée en silence.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { MemoryAnchorPublisher, anchorImprint, anchorReceipt, type Anchor, type AnchorPublication, type AnchorPublisher } from "./anchoring.js";
import { buildTimeStampRequest, parseTimeStampResponse } from "./anchoring-rfc3161.js";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Erreur de publication : l'ancre reste en base, marquée FAILED, et sera réessayée. */
export class AnchorPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorPublicationError";
  }
}

// ---------------------------------------------------------------------------
// RFC 3161
// ---------------------------------------------------------------------------

export interface Rfc3161Options {
  /** URL de l'autorité d'horodatage (https attendu en production). */
  url: string;
  /** En-tête `Authorization` si la TSA est sous contrat authentifié. */
  authorization?: string;
  /** OID de politique exigé de la TSA. */
  policyOid?: string;
  timeoutMs?: number;
  /** Injection pour les tests. */
  fetchImpl?: typeof fetch;
}

export class Rfc3161AnchorPublisher implements AnchorPublisher {
  readonly name = "rfc3161";
  constructor(private readonly opts: Rfc3161Options) {}

  async publish(anchor: Anchor): Promise<AnchorPublication> {
    const imprint = anchorImprint(anchor);
    const request = buildTimeStampRequest(Buffer.from(imprint, "hex"), {
      certReq: true,
      ...(this.opts.policyOid ? { policyOid: this.opts.policyOid } : {}),
    });
    const doFetch = this.opts.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/timestamp-query",
          accept: "application/timestamp-reply",
          ...(this.opts.authorization ? { authorization: this.opts.authorization } : {}),
        },
        body: request,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AnchorPublicationError(`Autorité d'horodatage injoignable (${this.opts.url}) : ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!response.ok) throw new AnchorPublicationError(`Autorité d'horodatage : HTTP ${response.status}`);

    const raw = Buffer.from(await response.arrayBuffer());
    let parsed;
    try {
      parsed = parseTimeStampResponse(raw);
    } catch (e) {
      throw new AnchorPublicationError(`Réponse d'horodatage illisible : ${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed.status > 1 || !parsed.token) {
      throw new AnchorPublicationError(`Horodatage refusé par la TSA (état ${parsed.status} : ${parsed.statusText ?? "sans motif"})`);
    }
    // Contrôle immédiat : la TSA a-t-elle scellé NOTRE empreinte ? Un jeton qui
    // porte autre chose ne prouve rien de cette ancre.
    if (parsed.imprint && parsed.imprint !== imprint) {
      throw new AnchorPublicationError(`La TSA a horodaté une autre empreinte (attendu ${imprint}, reçu ${parsed.imprint})`);
    }

    return {
      publisher: this.name,
      reference: `rfc3161:${new URL(this.opts.url).host}:${parsed.serialNumber ?? createHash("sha256").update(raw).digest("hex").slice(0, 16)}`,
      publishedAt: parsed.genTime ?? new Date().toISOString(),
      proof: parsed.token,
      verifyWith:
        "base64 -d > ancre.tsr ; openssl ts -reply -in ancre.tsr -text (l'empreinte affichée doit être sha256 du reçu) ; " +
        "openssl ts -verify -data recu.txt -in ancre.tsr -CAfile <chaîne de la TSA>",
    };
  }
}

// ---------------------------------------------------------------------------
// Dépôt signé chez l'exploitant
// ---------------------------------------------------------------------------

export interface SignedEndpointOptions {
  /** Point de collecte (https attendu en production). */
  url: string;
  /** Clé privée Ed25519 servant à signer le reçu. */
  privateKey: KeyObject;
  /** En-tête `Authorization` du point de collecte, si besoin. */
  authorization?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Corps déposé : tout ce qu'il faut pour revérifier, sans rien du contenu comptable. */
export interface SignedAnchorEnvelope {
  version: string;
  tenantId: string;
  day: string;
  prevAnchorHash: string | null;
  merkleRoot: string;
  leafCount: number;
  anchorHash: string;
  receipt: string;
  receiptSha256: string;
  algorithm: "ed25519";
  publicKey: string;
  signature: string;
  sentAt: string;
}

export class SignedEndpointAnchorPublisher implements AnchorPublisher {
  readonly name = "endpoint";
  private readonly publicKeyB64: string;

  constructor(private readonly opts: SignedEndpointOptions) {
    this.publicKeyB64 = createPublicKey(opts.privateKey).export({ format: "der", type: "spki" }).toString("base64");
  }

  /** Clé publique (SPKI DER, base64) à remettre à l'auditeur : c'est elle qui vérifie les reçus. */
  get publicKey(): string {
    return this.publicKeyB64;
  }

  async publish(anchor: Anchor): Promise<AnchorPublication> {
    const receipt = anchorReceipt(anchor);
    const signature = cryptoSign(null, Buffer.from(receipt, "utf8"), this.opts.privateKey).toString("base64");
    const envelope: SignedAnchorEnvelope = {
      version: "ARCOMPT-ANCHOR-v1",
      tenantId: anchor.tenantId,
      day: anchor.day,
      prevAnchorHash: anchor.prevAnchorHash,
      merkleRoot: anchor.merkleRoot,
      leafCount: anchor.entryCount,
      anchorHash: anchor.anchorHash,
      receipt,
      receiptSha256: anchorImprint(anchor),
      algorithm: "ed25519",
      publicKey: this.publicKeyB64,
      signature,
      sentAt: new Date().toISOString(),
    };
    const body = JSON.stringify(envelope);
    const doFetch = this.opts.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-arcompt-anchor-signature": `ed25519=${signature}`,
          "x-arcompt-anchor-key": this.publicKeyB64,
          ...(this.opts.authorization ? { authorization: this.opts.authorization } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AnchorPublicationError(`Point de dépôt d'ancres injoignable (${this.opts.url}) : ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!response.ok) throw new AnchorPublicationError(`Point de dépôt d'ancres : HTTP ${response.status}`);

    // L'accusé du destinataire, s'il en rend un, devient la référence citable ;
    // sinon on cite l'empreinte du dépôt, qui reste vérifiable des deux côtés.
    const text = (await response.text().catch(() => "")).slice(0, 2000);
    let reference: string | undefined;
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === "object") {
        const r = json as Record<string, unknown>;
        const candidate = r.reference ?? r.id ?? r.receipt;
        if (typeof candidate === "string" && candidate.trim() !== "") reference = candidate.trim().slice(0, 200);
      }
    } catch {
      /* le destinataire n'a pas répondu en JSON : ce n'est pas une erreur */
    }
    const host = new URL(this.opts.url).host;

    return {
      publisher: this.name,
      reference: reference ?? `endpoint:${host}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`,
      // Le destinataire n'atteste pas l'heure : c'est la nôtre, et le dire est
      // le minimum — un auditeur doit savoir que cette date vaut moins qu'un
      // genTime de TSA.
      publishedAt: new Date().toISOString(),
      proof: Buffer.from(JSON.stringify({ receiptSha256: envelope.receiptSha256, algorithm: "ed25519", publicKey: this.publicKeyB64, signature, endpoint: this.opts.url }), "utf8").toString("base64"),
      verifyWith:
        "base64 -d | jq -r .signature | base64 -d > sig.bin ; (clé publique en SPKI DER) " +
        "openssl pkeyutl -verify -pubin -inkey cle.pem -rawin -in recu.txt -sigfile sig.bin",
    };
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Lecture de `ANCHOR_SIGNING_KEY` : PEM PKCS#8, ou base64 du DER PKCS#8. */
export function readSigningKey(value: string): KeyObject {
  const trimmed = value.trim();
  const key = trimmed.includes("BEGIN")
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`clé Ed25519 attendue, reçu « ${key.asymmetricKeyType ?? "inconnu"} »`);
  return key;
}

export interface AnchorPublisherConfig {
  /** Publieur retenu, ou `null` : l'ancrage est alors hors service. */
  publisher: AnchorPublisher | null;
  /** Nom demandé par la configuration (`""` si aucune). */
  requested: string;
  /** Problèmes bloquants : une configuration posée à moitié n'est pas un repli, c'est une erreur. */
  problems: readonly string[];
  /** Fonctions volontairement coupées, à journaliser au démarrage. */
  degraded: readonly string[];
}

const present = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Construit le publieur depuis l'environnement, selon la règle maison
 * (`apps/api/src/config.ts`) : rien de configuré = fonction coupée et annoncée,
 * configuration incomplète = problème bloquant, simulateur = interdit en
 * production.
 *
 *   ANCHOR_PUBLISHER      rfc3161 | endpoint | memory   (absent : ancrage coupé)
 *   ANCHOR_TSA_URL        rfc3161 : URL de l'autorité d'horodatage
 *   ANCHOR_TSA_AUTH       rfc3161 : en-tête Authorization, facultatif
 *   ANCHOR_TSA_POLICY_OID rfc3161 : OID de politique exigé, facultatif
 *   ANCHOR_ENDPOINT_URL   endpoint : point de collecte
 *   ANCHOR_SIGNING_KEY    endpoint : clé privée Ed25519 (PEM ou base64 DER PKCS#8)
 *   ANCHOR_ENDPOINT_AUTH  endpoint : en-tête Authorization, facultatif
 */
export function anchorPublisherFromEnv(env: NodeJS.ProcessEnv = process.env): AnchorPublisherConfig {
  const requested = present(env.ANCHOR_PUBLISHER) ? env.ANCHOR_PUBLISHER.trim().toLowerCase() : "";
  const problems: string[] = [];
  const degraded: string[] = [];
  const isProduction = env.NODE_ENV === "production";

  if (requested === "") {
    degraded.push(
      "Ancrage externe désactivé : ANCHOR_PUBLISHER est absent. Les ancres ne sont ni calculées ni publiées, " +
        "et l'immutabilité du grand livre n'est prouvable que par la base elle-même (SECURITY.md engagement n° 10).",
    );
    return { publisher: null, requested, problems, degraded };
  }

  if (requested === "memory") {
    if (isProduction) {
      problems.push(
        "ANCHOR_PUBLISHER vaut « memory » — le publieur de test garde les ancres dans la mémoire du processus et les perd au redémarrage : il ne prouve rien à personne. Interdit en production.",
      );
      return { publisher: null, requested, problems, degraded };
    }
    degraded.push("SIMULATION : publieur d'ancres « memory » — les ancres ne quittent pas le processus, aucune preuve n'est opposable. Jamais en production.");
    return { publisher: new MemoryAnchorPublisher(), requested, problems, degraded };
  }

  if (requested === "rfc3161") {
    if (!present(env.ANCHOR_TSA_URL)) {
      problems.push("ANCHOR_TSA_URL : absent alors que ANCHOR_PUBLISHER vaut « rfc3161 » — aucune autorité d'horodatage à qui soumettre les ancres.");
      return { publisher: null, requested, problems, degraded };
    }
    if (isProduction && !env.ANCHOR_TSA_URL.trim().startsWith("https://")) {
      problems.push("ANCHOR_TSA_URL : https attendu en production — une requête d'horodatage en clair est interceptable.");
      return { publisher: null, requested, problems, degraded };
    }
    return {
      publisher: new Rfc3161AnchorPublisher({
        url: env.ANCHOR_TSA_URL.trim(),
        ...(present(env.ANCHOR_TSA_AUTH) ? { authorization: env.ANCHOR_TSA_AUTH.trim() } : {}),
        ...(present(env.ANCHOR_TSA_POLICY_OID) ? { policyOid: env.ANCHOR_TSA_POLICY_OID.trim() } : {}),
      }),
      requested,
      problems,
      degraded,
    };
  }

  if (requested === "endpoint") {
    if (!present(env.ANCHOR_ENDPOINT_URL)) problems.push("ANCHOR_ENDPOINT_URL : absent alors que ANCHOR_PUBLISHER vaut « endpoint » — aucun point de dépôt où déposer les ancres.");
    if (!present(env.ANCHOR_SIGNING_KEY)) problems.push("ANCHOR_SIGNING_KEY : absente alors que ANCHOR_PUBLISHER vaut « endpoint » — un reçu non signé ne prouve pas son origine.");
    if (present(env.ANCHOR_ENDPOINT_URL) && isProduction && !env.ANCHOR_ENDPOINT_URL.trim().startsWith("https://")) {
      problems.push("ANCHOR_ENDPOINT_URL : https attendu en production.");
    }
    if (problems.length > 0) return { publisher: null, requested, problems, degraded };
    let privateKey: KeyObject;
    try {
      privateKey = readSigningKey(env.ANCHOR_SIGNING_KEY!);
    } catch (e) {
      problems.push(`ANCHOR_SIGNING_KEY : illisible — ${e instanceof Error ? e.message : String(e)}.`);
      return { publisher: null, requested, problems, degraded };
    }
    return {
      publisher: new SignedEndpointAnchorPublisher({
        url: env.ANCHOR_ENDPOINT_URL!.trim(),
        privateKey,
        ...(present(env.ANCHOR_ENDPOINT_AUTH) ? { authorization: env.ANCHOR_ENDPOINT_AUTH.trim() } : {}),
      }),
      requested,
      problems,
      degraded,
    };
  }

  problems.push(`ANCHOR_PUBLISHER : valeur « ${requested} » inconnue — attendu « rfc3161 », « endpoint », ou « memory » hors production.`);
  return { publisher: null, requested, problems, degraded };
}
