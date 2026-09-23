/**
 * Mise en service de l'ancrage : produire l'ancre du jour, la publier hors de
 * la plateforme, et répondre à la seule question qui compte pour un auditeur —
 * « prouvez-moi que cette écriture existait, inchangée, à cette date ».
 *
 * Trois règles de conduite, qui expliquent la plupart du code ci-dessous.
 *
 * 1. On n'ancre jamais le jour courant. Une journée ouverte reçoit encore des
 *    écritures ; sa racine changerait après la publication, et l'ancre
 *    deviendrait invérifiable — le pire des résultats, puisqu'elle ressemble
 *    toujours à une preuve.
 * 2. On n'ancre pas les journées vides. La chaîne d'ancres n'exige pas des
 *    jours contigus ; écrire une ancre par week-end et par jour férié
 *    n'ajouterait rien à la preuve et beaucoup de bruit.
 * 3. Publier, c'est réussir. Tant qu'un tiers n'a rien reçu, l'ancre est
 *    conservée en PENDING ou FAILED, et l'engagement n'est pas tenu. On ne
 *    marque jamais « publiée » une ancre qui n'est pas sortie.
 */

import {
  buildDailyAnchor,
  leafValue,
  merkleProof,
  orderLeaves,
  verifyAnchorChain,
  verifyMerkleProof,
  type Anchor,
  type AnchorLeaf,
  type AnchorPublisher,
  type MerkleProof,
} from "./anchoring.js";
import { recomputeAnchor, type AnchorRecord, type PostgresAnchorStore } from "./anchoring-store.js";
import type { Id } from "./types.js";

export type AnchoringErrorCode =
  | "ANCHORING_DISABLED"
  | "DAY_NOT_ELAPSED"
  | "DAY_BEFORE_LAST_ANCHOR"
  | "NOTHING_TO_ANCHOR"
  | "ANCHOR_NOT_FOUND"
  | "LEAF_NOT_FOUND"
  | "ANCHOR_MISMATCH"
  | "PUBLICATION_FAILED";

export class AnchoringError extends Error {
  override name = "AnchoringError";
  constructor(
    readonly code: AnchoringErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Jour UTC d'un instant, au format AAAA-MM-JJ. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface AnchoringServiceOptions {
  store: PostgresAnchorStore;
  /** `null` : l'ancrage est configuré hors service ; rien n'est calculé ni publié. */
  publisher: AnchorPublisher | null;
  now?: () => Date;
  /** Auteur consigné dans `ledger_anchor.built_by` (tâche de fond : absent). */
  builtBy?: Id;
}

/** Ce qu'une exécution de la tâche quotidienne a réellement fait, dossier par dossier. */
export interface AnchoringRunReport {
  tenantId: Id;
  built: string[];
  published: Array<{ day: string; publisher: string; reference: string; publishedAt: string }>;
  failed: Array<{ day: string; error: string }>;
  /** Jours d'activité devenus inancrables (antérieurs à la dernière ancre) : anomalie à signaler. */
  unanchorable: string[];
}

export interface AnchorProofResult {
  anchor: AnchorRecord;
  leaf: AnchorLeaf;
  proof: MerkleProof;
  /** La preuve se replie-t-elle bien sur la racine scellée ? */
  verified: boolean;
  /**
   * La racine recalculée aujourd'hui depuis la base est-elle celle qui a été
   * scellée ? `false` signifie qu'une donnée du jour a bougé depuis l'ancrage :
   * c'est le signal que tout ce dispositif existe pour lever.
   */
  rootMatchesToday: boolean;
  /** Vrai seulement si un tiers détient une trace de cette ancre. */
  published: boolean;
}

export interface AnchorChainReport {
  tenantId: Id;
  anchors: number;
  /** Chaînage des ancres entre elles. */
  chain: { ok: boolean; brokenAt?: string };
  /** Ancres dont la racine ne se recalcule plus à l'identique depuis la base. */
  tampered: string[];
  /** Ancres jamais sorties de la plateforme : elles ne prouvent rien à un tiers. */
  unpublished: string[];
  ok: boolean;
}

export class AnchoringService {
  private readonly store: PostgresAnchorStore;
  private readonly publisher: AnchorPublisher | null;
  private readonly now: () => Date;
  private readonly builtBy: Id | undefined;

  constructor(opts: AnchoringServiceOptions) {
    this.store = opts.store;
    this.publisher = opts.publisher;
    this.now = opts.now ?? (() => new Date());
    this.builtBy = opts.builtBy;
  }

  get enabled(): boolean {
    return this.publisher !== null;
  }

  private requireEnabled(): AnchorPublisher {
    if (!this.publisher) {
      throw new AnchoringError(
        "ANCHORING_DISABLED",
        "Ancrage externe hors service : aucun publieur configuré (ANCHOR_PUBLISHER). Les ancres ne sont ni calculées ni publiées.",
      );
    }
    return this.publisher;
  }

  /**
   * Calcule et conserve l'ancre d'un jour révolu. Idempotent : si l'ancre
   * existe déjà, elle est relue telle quelle — jamais recalculée, sans quoi une
   * modification ultérieure des données produirait une ancre différente sous le
   * même jour.
   */
  async buildDay(tenantId: Id, day: string): Promise<AnchorRecord> {
    this.requireEnabled();
    const existing = await this.store.getAnchor(tenantId, day);
    if (existing) return existing;

    if (day >= utcDay(this.now())) {
      throw new AnchoringError("DAY_NOT_ELAPSED", `Le ${day} n'est pas révolu (UTC) : une journée ouverte reçoit encore des écritures, son ancre serait fausse dès demain.`);
    }
    const last = await this.store.lastAnchor(tenantId);
    if (last && day <= last.day) {
      throw new AnchoringError("DAY_BEFORE_LAST_ANCHOR", `Le ${day} précède la dernière ancre (${last.day}) : l'insérer réécrirait la chaîne d'ancres.`, { lastAnchoredDay: last.day });
    }
    const leaves = await this.store.dailyLeaves(tenantId, day);
    if (leaves.length === 0) throw new AnchoringError("NOTHING_TO_ANCHOR", `Aucune écriture validée ni ligne d'audit le ${day} : rien à ancrer.`);

    const anchor = buildDailyAnchor(tenantId, day, leaves, last?.anchorHash ?? null);
    return this.store.insertAnchor(anchor, this.builtBy);
  }

  /** Publie une ancre conservée. L'échec est consigné sur l'ancre, jamais avalé. */
  async publish(record: AnchorRecord): Promise<AnchorRecord> {
    const publisher = this.requireEnabled();
    if (record.status === "PUBLISHED") return record;
    try {
      const publication = await publisher.publish(toAnchor(record));
      return await this.store.markPublished(record.tenantId, record.day, publication);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.store.markFailed(record.tenantId, record.day, message);
      throw new AnchoringError("PUBLICATION_FAILED", `Publication de l'ancre du ${record.day} impossible : ${message}`, { day: record.day });
    }
  }

  /**
   * Tâche quotidienne d'un dossier : ancrer tous les jours révolus non encore
   * ancrés, puis publier tout ce qui n'est pas sorti (y compris les ancres
   * d'exécutions précédentes restées en échec).
   */
  async run(tenantId: Id): Promise<AnchoringRunReport> {
    this.requireEnabled();
    const report: AnchoringRunReport = { tenantId, built: [], published: [], failed: [], unanchorable: [] };

    for (const day of await this.store.pendingDays(tenantId, utcDay(this.now()))) {
      try {
        await this.buildDay(tenantId, day);
        report.built.push(day);
      } catch (e) {
        if (e instanceof AnchoringError && e.code === "NOTHING_TO_ANCHOR") continue;
        report.failed.push({ day, error: e instanceof Error ? e.message : String(e) });
      }
    }

    for (const record of await this.store.listAnchors(tenantId)) {
      if (record.status === "PUBLISHED") continue;
      try {
        const published = await this.publish(record);
        report.published.push({ day: published.day, publisher: published.publisher ?? "", reference: published.publicationRef ?? "", publishedAt: published.publishedAt ?? "" });
      } catch (e) {
        report.failed.push({ day: record.day, error: e instanceof Error ? e.message : String(e) });
      }
    }

    report.unanchorable = await this.store.unanchorableDays(tenantId);
    return report;
  }

  /**
   * Preuve d'inclusion d'une écriture (ou d'une ligne d'audit) dans l'ancre de
   * son jour. La preuve est reconstruite depuis la base, puis confrontée à la
   * racine scellée : si les données ont bougé, la réponse le dit au lieu de
   * fabriquer une preuve cohérente avec l'état actuel.
   */
  async proofFor(tenantId: Id, target: { entryId?: Id; auditId?: string }): Promise<AnchorProofResult> {
    const located = target.entryId
      ? await this.store.entryDay(tenantId, target.entryId).then((r) => (r ? { ...r, kind: "ENTRY" as const, ref: target.entryId! } : null))
      : target.auditId
        ? await this.store.auditDay(tenantId, target.auditId).then((r) => (r ? { ...r, kind: "AUDIT" as const, ref: target.auditId! } : null))
        : null;
    if (!located) {
      throw new AnchoringError("LEAF_NOT_FOUND", target.entryId ? `Écriture validée ${target.entryId} introuvable dans ce dossier.` : `Ligne d'audit ${target.auditId} introuvable dans ce dossier.`);
    }

    const anchor = await this.store.getAnchor(tenantId, located.day);
    if (!anchor) {
      throw new AnchoringError("ANCHOR_NOT_FOUND", `Aucune ancre pour le ${located.day} : cette journée n'a pas encore été ancrée.`, { day: located.day });
    }

    const leaves = orderLeaves(await this.store.dailyLeaves(tenantId, located.day));
    const { ok: rootMatchesToday } = recomputeAnchor(anchor, leaves);
    const index = leaves.findIndex((l) => l.kind === located.kind && l.ref === located.ref);
    if (index < 0) {
      throw new AnchoringError("ANCHOR_MISMATCH", `La feuille demandée n'est plus dans les données du ${located.day} : l'ancre et la base ne concordent plus.`, { day: located.day });
    }

    const proof = merkleProof(leaves.map(leafValue), index);
    const leaf = leaves[index]!;
    return {
      anchor,
      leaf,
      proof,
      verified: verifyMerkleProof(proof) && proof.root === anchor.merkleRoot,
      rootMatchesToday,
      published: anchor.status === "PUBLISHED",
    };
  }

  /**
   * Vérification complète d'un dossier : chaînage des ancres entre elles, et
   * recalcul de chaque racine depuis les données d'aujourd'hui. La seconde
   * vérification est la seule qui détecte une modification a posteriori ; la
   * première ne détecte qu'une réécriture de la table d'ancres.
   */
  async verifyChain(tenantId: Id): Promise<AnchorChainReport> {
    const anchors = await this.store.listAnchors(tenantId);
    const chain = verifyAnchorChain(anchors.map(toAnchor));
    const tampered: string[] = [];
    for (const anchor of anchors) {
      const leaves = await this.store.dailyLeaves(tenantId, anchor.day);
      if (!recomputeAnchor(anchor, leaves).ok) tampered.push(anchor.day);
    }
    const unpublished = anchors.filter((a) => a.status !== "PUBLISHED").map((a) => a.day);
    return { tenantId, anchors: anchors.length, chain, tampered, unpublished, ok: chain.ok && tampered.length === 0 };
  }
}

/** Projection d'une ligne de base vers la forme scellée (celle qui entre dans les hashes). */
export function toAnchor(record: AnchorRecord): Anchor {
  return {
    tenantId: record.tenantId,
    day: record.day,
    merkleRoot: record.merkleRoot,
    prevAnchorHash: record.prevAnchorHash,
    anchorHash: record.anchorHash,
    entryCount: record.entryCount,
  };
}
