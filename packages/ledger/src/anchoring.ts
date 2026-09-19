import { createHash } from "node:crypto";
import type { JournalEntry } from "./types.js";

/**
 * Ancrage externe de la chaîne de hash (SECURITY.md §6, engagement n° 10).
 *
 * Chaque jour, pour chaque dossier, on calcule la racine de Merkle des hashes
 * des écritures validées de la journée (tous journaux confondus, triées par
 * journal puis numéro). Cette racine, jointe à la racine de la veille, forme
 * une chaîne d'ancres que l'on publie hors de la plateforme (horodatage
 * qualifié, registre public…). Quiconque détient l'ancre publiée peut prouver
 * qu'une écriture existait, inchangée, à la date de publication.
 */
export interface Anchor {
  tenantId: string;
  /** Jour couvert (AAAA-MM-JJ, date de validation). */
  day: string;
  /** Racine de Merkle des hashes d'écritures du jour ("" si aucune). */
  merkleRoot: string;
  /** Hash de l'ancre précédente du dossier, ou null pour la première. */
  prevAnchorHash: string | null;
  /** sha256(prevAnchorHash | day | merkleRoot | count). */
  anchorHash: string;
  entryCount: number;
}

export interface MerkleProof {
  leaf: string;
  /** Frères successifs avec leur côté. */
  path: Array<{ hash: string; side: "L" | "R" }>;
  root: string;
}

const h = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Racine de Merkle sur des feuilles hexadécimales ; duplique la dernière feuille sur un niveau impair. */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return "";
  let level = leaves.map((l) => h("leaf:" + l));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(h("node:" + a + b));
    }
    level = next;
  }
  return level[0]!;
}

/** Preuve d'inclusion d'une feuille dans la racine. */
export function merkleProof(leaves: string[], index: number): MerkleProof {
  if (index < 0 || index >= leaves.length) throw new Error("Indice hors des feuilles");
  let level = leaves.map((l) => h("leaf:" + l));
  let idx = index;
  const path: MerkleProof["path"] = [];
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sib = level[sibling] ?? level[idx]!;
    path.push({ hash: sib, side: idx % 2 === 0 ? "R" : "L" });
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(h("node:" + level[i]! + (level[i + 1] ?? level[i]!)));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { leaf: leaves[index]!, path, root: level[0]! };
}

export function verifyMerkleProof(proof: MerkleProof): boolean {
  let cur = h("leaf:" + proof.leaf);
  for (const step of proof.path) {
    cur = step.side === "R" ? h("node:" + cur + step.hash) : h("node:" + step.hash + cur);
  }
  return cur === proof.root;
}

/** Feuilles du jour : hashes des écritures validées, dans un ordre canonique. */
export function dailyLeaves(entries: JournalEntry[], day: string): string[] {
  return entries
    .filter((e) => e.status === "VALIDATED" && e.hash && (e.validatedAt ?? "").slice(0, 10) === day)
    .sort((a, b) => a.journalCode.localeCompare(b.journalCode) || (a.number ?? 0) - (b.number ?? 0))
    .map((e) => e.hash!);
}

export function buildAnchor(tenantId: string, day: string, leaves: string[], prevAnchorHash: string | null): Anchor {
  const root = merkleRoot(leaves);
  const anchorHash = h(`${prevAnchorHash ?? "GENESIS"}|${day}|${root}|${leaves.length}`);
  return { tenantId, day, merkleRoot: root, prevAnchorHash, anchorHash, entryCount: leaves.length };
}

/** Vérifie une chaîne d'ancres (ordre chronologique) et sa cohérence interne. */
export function verifyAnchorChain(anchors: Anchor[]): { ok: boolean; brokenAt?: string } {
  let prev: string | null = null;
  for (const a of [...anchors].sort((x, y) => x.day.localeCompare(y.day))) {
    const expected = h(`${prev ?? "GENESIS"}|${a.day}|${a.merkleRoot}|${a.entryCount}`);
    if (a.prevAnchorHash !== prev || a.anchorHash !== expected) return { ok: false, brokenAt: a.day };
    prev = a.anchorHash;
  }
  return { ok: true };
}

/**
 * Fournisseur de publication externe. Implémentations attendues : horodatage
 * qualifié (RFC 3161), registre public (dépôt Git signé, blockchain publique),
 * ou simple envoi par courriel signé au commissaire aux comptes.
 */
export interface AnchorPublisher {
  publish(anchor: Anchor): Promise<{ reference: string; publishedAt: string }>;
}

/** Fournisseur de test/développement : mémorise les ancres publiées. */
export class MemoryAnchorPublisher implements AnchorPublisher {
  readonly published: Anchor[] = [];
  async publish(anchor: Anchor) {
    this.published.push(anchor);
    return { reference: `memory:${anchor.tenantId}:${anchor.day}`, publishedAt: new Date().toISOString() };
  }
}
