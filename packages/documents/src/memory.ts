import type { Sql } from "postgres";

/**
 * Mémoire des catégorisations : chaque validation ou correction humaine est
 * mémorisée (tiers, libellé, compte). À la proposition suivante, on cherche le
 * plus proche voisin. pgvector est facultatif : la recherche de repli compare
 * les jetons normalisés (Jaccard) et les trigrammes de caractères (Dice).
 */
const STOP_WORDS = new Set(["de", "du", "des", "la", "le", "les", "et", "en", "un", "une", "au", "aux", "pour", "par", "sur", "the", "of", "sa", "sarl", "sas", "ci", "n", "no", "facture", "fact"]);

export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Jetons significatifs : mots ≥ 2 caractères hors mots vides, sans les nombres purs de plus de 4 chiffres (montants, références). */
export function tokenize(s: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const w of normalizeText(s).split(" ")) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    if (/^\d{5,}$/.test(w)) continue;
    out.add(w);
  }
  return [...out];
}

export function trigrams(s: string): Set<string> {
  const t = `  ${normalizeText(s)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function diceTrigrams(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Similarité 0..1 entre deux libellés : le meilleur des deux indicateurs. */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(jaccard(tokenize(na), tokenize(nb)), diceTrigrams(na, nb));
}

export interface MemoryEntry {
  id: string;
  partnerName: string | null;
  description: string;
  accountNumber: string;
  vatCode: string | null;
  source: "HUMAN_CORRECTION" | "HUMAN_VALIDATION";
  createdAt: string;
}

export interface MemoryQuery {
  partnerName: string | null;
  description: string;
}

export interface MemoryMatch extends MemoryEntry {
  score: number;
}

/**
 * Score d'un souvenir face à une requête. Le tiers pèse davantage que le
 * libellé (une facture CIE reste de l'électricité quel que soit le mois).
 */
export function scoreMemory(query: MemoryQuery, entry: Pick<MemoryEntry, "partnerName" | "description">): number {
  const partnerSim = query.partnerName && entry.partnerName ? textSimilarity(query.partnerName, entry.partnerName) : null;
  const descSim = textSimilarity(query.description, entry.description);
  if (partnerSim === null) return descSim;
  if (!normalizeText(query.description)) return partnerSim;
  return 0.6 * partnerSim + 0.4 * Math.max(descSim, partnerSim === 1 ? 0.5 : 0);
}

/** Classement : score, puis correction humaine avant simple validation, puis le plus récent. */
export function rankMatches(query: MemoryQuery, entries: MemoryEntry[], threshold = 0.6): MemoryMatch[] {
  return entries
    .map((e) => ({ ...e, score: scoreMemory(query, e) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score || (a.source === b.source ? 0 : a.source === "HUMAN_CORRECTION" ? -1 : 1) || b.createdAt.localeCompare(a.createdAt));
}

/** Accès SQL à `categorization_memory` ; toujours dans une transaction tenant (`withTenant`). */
export class CategorizationMemoryStore {
  constructor(private readonly tenantId: string) {}

  async record(tx: Sql, entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string> {
    const tokens = tokenize(`${entry.partnerName ?? ""} ${entry.description}`);
    const [row] = await tx`
      INSERT INTO categorization_memory (tenant_id, partner_name, description, account_number, vat_code, source, tokens)
      VALUES (${this.tenantId}, ${entry.partnerName}, ${entry.description}, ${entry.accountNumber}, ${entry.vatCode}, ${entry.source}, ${tokens})
      RETURNING id`;
    return row!.id as string;
  }

  /**
   * Plus proches voisins. Si un vecteur est fourni et que la colonne
   * `embedding` existe (pgvector), la distance cosinus est utilisée ; sinon
   * repli sur le recouvrement de jetons.
   */
  async nearest(tx: Sql, query: MemoryQuery, opts: { limit?: number; threshold?: number; embedding?: number[] } = {}): Promise<MemoryMatch[]> {
    const limit = opts.limit ?? 5;
    if (opts.embedding && (await this.hasEmbeddingColumn(tx))) {
      const vec = `[${opts.embedding.join(",")}]`;
      const rows = await tx.unsafe(
        `SELECT id, partner_name, description, account_number, vat_code, source, created_at, 1 - (embedding <=> $2::vector) AS score
           FROM categorization_memory WHERE tenant_id = $1 AND embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector LIMIT $3`,
        [this.tenantId, vec, limit],
      );
      return rows.map((r) => ({ ...mapMemory(r as Record<string, unknown>), score: Number(r.score) })).filter((m) => m.score >= (opts.threshold ?? 0.6));
    }
    const tokens = tokenize(`${query.partnerName ?? ""} ${query.description}`);
    const partner = normalizeText(query.partnerName);
    const rows = await tx`
      SELECT id, partner_name, description, account_number, vat_code, source, created_at
        FROM categorization_memory
       WHERE tenant_id = ${this.tenantId}
         AND (tokens && ${tokens}::text[] OR (${partner} <> '' AND lower(coalesce(partner_name, '')) = ${partner}))
       ORDER BY created_at DESC LIMIT 200`;
    return rankMatches(query, rows.map((r) => mapMemory(r as Record<string, unknown>)), opts.threshold).slice(0, limit);
  }

  private async hasEmbeddingColumn(tx: Sql): Promise<boolean> {
    const rows = await tx`SELECT 1 FROM information_schema.columns WHERE table_name = 'categorization_memory' AND column_name = 'embedding'`;
    return rows.length > 0;
  }
}

function mapMemory(r: Record<string, unknown>): MemoryEntry {
  return {
    id: r.id as string,
    partnerName: (r.partner_name as string | null) ?? null,
    description: r.description as string,
    accountNumber: r.account_number as string,
    vatCode: (r.vat_code as string | null) ?? null,
    source: r.source as MemoryEntry["source"],
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}
