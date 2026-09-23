import { createHash } from "node:crypto";
import type { JournalEntry } from "./types.js";

/**
 * Ancrage externe de la chaîne de hash (SECURITY.md §6, engagement n° 10).
 *
 * Chaque jour, pour chaque dossier, on calcule la racine de Merkle des hashes
 * déjà chaînés de la journée. Cette racine, jointe à l'ancre de la veille, forme
 * une chaîne d'ancres que l'on publie hors de la plateforme (horodatage
 * qualifié, registre public…). Quiconque détient l'ancre publiée peut prouver
 * qu'une écriture existait, inchangée, à la date de publication.
 *
 * **Ce qui est ancré.** Le produit tient deux chaînes de hash (§6 : « chaînage
 * par hash des écritures **et du journal d'audit** ») : `journal_entry.hash`,
 * une chaîne par journal, et `audit_log.hash`, une chaîne par dossier. L'ancre
 * du jour couvre les deux. N'ancrer que les écritures — ce que faisait
 * `dailyLeaves()` seul — prouverait qu'une écriture existait sans rien prouver
 * de qui l'a validée, ni du déverrouillage de période qui l'a précédée : la
 * moitié de la preuve que l'engagement annonce. Chaque feuille porte donc son
 * domaine (`ENTRY:` / `AUDIT:`), ce qui interdit aussi de faire passer un hash
 * d'audit pour un hash d'écriture dans une preuve d'inclusion.
 */
export interface Anchor {
  tenantId: string;
  /** Jour couvert (AAAA-MM-JJ, en UTC). */
  day: string;
  /** Racine de Merkle des feuilles du jour ("" si aucune). */
  merkleRoot: string;
  /** Hash de l'ancre précédente du dossier, ou null pour la première. */
  prevAnchorHash: string | null;
  /** sha256(prevAnchorHash | day | merkleRoot | count). */
  anchorHash: string;
  /**
   * Nombre de feuilles scellées par la racine — écritures **et** lignes
   * d'audit. Le nom est conservé pour ne pas rompre la formule du hash, déjà
   * publiée ; `DailyAnchor.counts` donne le détail par domaine.
   */
  entryCount: number;
}

/** Domaines de feuilles ancrés : les deux chaînes de hash du produit. */
export type AnchorLeafKind = "ENTRY" | "AUDIT";

/** Une feuille de l'arbre du jour : un hash déjà chaîné, et de quoi le retrouver. */
export interface AnchorLeaf {
  kind: AnchorLeafKind;
  /** `journal_entry.hash` ou `audit_log.hash`. */
  hash: string;
  /** Identifiant de la ligne source (`journal_entry.id`, `audit_log.id`). */
  ref: string;
}

/**
 * Valeur canonique d'une feuille. Le domaine est préfixé : sans lui, un hash
 * d'audit et un hash d'écriture seraient interchangeables dans une preuve.
 */
export function leafValue(leaf: Pick<AnchorLeaf, "kind" | "hash">): string {
  return `${leaf.kind}:${leaf.hash}`;
}

/** Ancre du jour, avec le détail des feuilles par domaine (informatif : la racine, elle, scelle le contenu réel). */
export interface DailyAnchor extends Anchor {
  counts: { entries: number; audit: number };
}

/**
 * Ordre canonique des feuilles du jour : les écritures d'abord (dans l'ordre où
 * l'appelant les a lues — journal puis numéro), les lignes d'audit ensuite
 * (identifiant croissant). Cet ordre est ce qui rend la racine reproductible
 * par un tiers des années plus tard ; il ne change pas sans changer la version
 * du reçu (`ANCHOR_RECEIPT_VERSION`).
 */
export function orderLeaves(leaves: AnchorLeaf[]): AnchorLeaf[] {
  return [...leaves.filter((l) => l.kind === "ENTRY"), ...leaves.filter((l) => l.kind === "AUDIT")];
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
 * Ancre du jour à partir des feuilles des deux chaînes.
 * Les feuilles sont remises dans l'ordre canonique, puis préfixées de leur
 * domaine avant hachage.
 */
export function buildDailyAnchor(tenantId: string, day: string, leaves: AnchorLeaf[], prevAnchorHash: string | null): DailyAnchor {
  const ordered = orderLeaves(leaves);
  const anchor = buildAnchor(tenantId, day, ordered.map(leafValue), prevAnchorHash);
  return {
    ...anchor,
    counts: {
      entries: ordered.filter((l) => l.kind === "ENTRY").length,
      audit: ordered.filter((l) => l.kind === "AUDIT").length,
    },
  };
}

/**
 * Version du reçu. Elle fixe à la fois le texte scellé et les conventions qu'il
 * suppose (ordre canonique des feuilles, préfixe de domaine, formule du hash
 * d'ancre). Changer l'une d'elles impose une nouvelle version : un reçu de 2026
 * doit rester vérifiable en 2036 avec les règles de 2026.
 */
export const ANCHOR_RECEIPT_VERSION = "ARCOMPT-ANCHOR-v1";

/**
 * Texte du reçu : c'est **lui**, et non la ligne de base, que l'on soumet au
 * tiers. Un horodateur RFC 3161 scelle son empreinte sha256 ; un point de dépôt
 * signé reçoit le texte entier. Un auditeur le reconstitue depuis la base (ou
 * depuis l'export) et doit retrouver exactement la même empreinte, caractère
 * pour caractère — d'où l'absence de tout champ variable (heure de calcul,
 * numéro de version du logiciel, mise en forme).
 */
export function anchorReceipt(anchor: Anchor): string {
  return [
    ANCHOR_RECEIPT_VERSION,
    `tenant=${anchor.tenantId}`,
    `day=${anchor.day}`,
    `prev=${anchor.prevAnchorHash ?? "GENESIS"}`,
    `root=${anchor.merkleRoot === "" ? "EMPTY" : anchor.merkleRoot}`,
    `leaves=${anchor.entryCount}`,
    `anchor=${anchor.anchorHash}`,
    "",
  ].join("\n");
}

/** Empreinte sha256 du reçu, en hexadécimal : ce que l'on fait horodater. */
export function anchorImprint(anchor: Anchor): string {
  return h(anchorReceipt(anchor));
}

/** Trace rendue par un tiers après publication. */
export interface AnchorPublication {
  /** Nom du publieur effectivement employé (`rfc3161`, `webhook`, `memory`…). */
  publisher: string;
  /** Référence courte et citable de la publication (numéro de série, accusé, identifiant du dépôt). */
  reference: string;
  /** Horodatage **rendu par le tiers** quand il en rend un ; sinon l'heure d'envoi, et c'est dit. */
  publishedAt: string;
  /** Preuve opposable à conserver telle quelle (base64) : jeton RFC 3161, signature du reçu… */
  proof?: string;
  /** Ce qu'un auditeur doit faire de `proof`, en une phrase. */
  verifyWith?: string;
}

/**
 * Fournisseur de publication externe. Implémentations livrées : horodatage
 * RFC 3161 (`Rfc3161AnchorPublisher`), dépôt signé chez l'exploitant
 * (`SignedEndpointAnchorPublisher`), et le publieur de test ci-dessous.
 */
export interface AnchorPublisher {
  /** Nom court, conservé dans `ledger_anchor.publisher`. */
  readonly name: string;
  publish(anchor: Anchor): Promise<AnchorPublication>;
}

/**
 * Fournisseur de test/développement : mémorise les ancres publiées.
 * Ne quitte jamais le processus, donc ne prouve rien à personne — interdit en
 * production (voir `anchorPublisherFromEnv`).
 */
export class MemoryAnchorPublisher implements AnchorPublisher {
  readonly name = "memory";
  readonly published: Anchor[] = [];
  async publish(anchor: Anchor): Promise<AnchorPublication> {
    this.published.push(anchor);
    return {
      publisher: this.name,
      reference: `memory:${anchor.tenantId}:${anchor.day}`,
      publishedAt: new Date().toISOString(),
      verifyWith: "Aucune vérification possible : l'ancre n'a pas quitté le processus.",
    };
  }
}
