// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Conservation des ancres (table `ledger_anchor`, migration 0013) et lecture
 * des feuilles du jour depuis les deux chaînes de hash du dossier.
 *
 * Aucune feuille n'est recopiée dans la table d'ancres : la preuve d'inclusion
 * est reconstruite à la demande depuis `journal_entry` et `audit_log`. C'est
 * volontaire. Si quelqu'un modifiait une écriture après coup, la reconstruction
 * donnerait une autre racine que celle scellée — et ce désaccord est exactement
 * le signal que l'ancrage existe pour produire. Recopier les feuilles aurait
 * masqué l'écart dans une seconde copie, elle aussi modifiable.
 */

import type { Sql } from "postgres";
import { buildDailyAnchor, type AnchorLeaf, type AnchorPublication, type DailyAnchor } from "./anchoring.js";
import type { Id } from "./types.js";

export type AnchorStatus = "PENDING" | "PUBLISHED" | "FAILED";

/** Une ancre telle qu'elle vit en base, publication comprise. */
export interface AnchorRecord extends DailyAnchor {
  id: Id;
  builtAt: string;
  status: AnchorStatus;
  publisher: string | null;
  publicationRef: string | null;
  publishedAt: string | null;
  publicationProof: string | null;
  publicationError: string | null;
}

interface AnchorRow {
  id: string;
  tenant_id: string;
  day: string;
  merkle_root: string;
  prev_anchor_hash: string | null;
  anchor_hash: string;
  leaf_count: number;
  entry_count: number;
  audit_count: number;
  built_at: Date | string;
  status: AnchorStatus;
  publisher: string | null;
  publication_ref: string | null;
  published_at: Date | string | null;
  publication_proof: string | null;
  publication_error: string | null;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * Colonnes d'une ancre. `day` est rendu en texte par la base : le pilote
 * traduirait sinon une `date` en `Date` JavaScript, dont la lecture dépend du
 * fuseau du processus — de quoi décaler d'un jour une preuve d'inclusion.
 */
const anchorSelect = (tx: Sql) => tx`
  SELECT id, tenant_id, to_char(day, 'YYYY-MM-DD') AS day, merkle_root, prev_anchor_hash, anchor_hash,
         leaf_count, entry_count, audit_count, built_at, status, publisher, publication_ref,
         published_at, publication_proof, publication_error
    FROM ledger_anchor`;

function mapAnchor(row: AnchorRow): AnchorRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    day: String(row.day).slice(0, 10),
    merkleRoot: row.merkle_root,
    prevAnchorHash: row.prev_anchor_hash,
    anchorHash: row.anchor_hash,
    entryCount: Number(row.leaf_count),
    counts: { entries: Number(row.entry_count), audit: Number(row.audit_count) },
    builtAt: iso(row.built_at)!,
    status: row.status,
    publisher: row.publisher,
    publicationRef: row.publication_ref,
    publishedAt: iso(row.published_at),
    publicationProof: row.publication_proof,
    publicationError: row.publication_error,
  };
}

/**
 * Accès PostgreSQL aux ancres. Chaque opération fixe `app.tenant_id` : la RLS
 * est active sur `ledger_anchor` comme sur le reste du schéma.
 */
export class PostgresAnchorStore {
  constructor(
    private readonly sql: Sql,
    private readonly ctx: { userId?: Id; organizationId?: Id } = {},
  ) {}

  private tx<T>(tenantId: Id, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`select set_config('app.organization_id', ${this.ctx.organizationId ?? ""}, true)`;
      await tx`select set_config('app.user_id', ${this.ctx.userId ?? ""}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  /**
   * Feuilles du jour, dans l'ordre canonique : écritures validées (journal puis
   * numéro), puis lignes d'audit (identifiant croissant). Le jour est celui de
   * l'horloge UTC — la même convention que `dailyLeaves()` côté mémoire, qui
   * découpe l'ISO 8601 en tête.
   */
  async dailyLeaves(tenantId: Id, day: string): Promise<AnchorLeaf[]> {
    return this.tx(tenantId, async (tx) => {
      const entries = await tx<{ hash: string; ref: string }[]>`
        SELECT e.hash, e.id::text AS ref
          FROM journal_entry e JOIN journal j ON j.id = e.journal_id
         WHERE e.tenant_id = ${tenantId} AND e.status = 'VALIDATED' AND e.hash IS NOT NULL
           AND (e.validated_at AT TIME ZONE 'UTC')::date = ${day}::date
         ORDER BY j.code, e.number`;
      const audit = await tx<{ hash: string; ref: string }[]>`
        SELECT a.hash, a.id::text AS ref
          FROM audit_log a
         WHERE a.tenant_id = ${tenantId} AND (a.at AT TIME ZONE 'UTC')::date = ${day}::date
         ORDER BY a.id`;
      return [
        ...entries.map((r) => ({ kind: "ENTRY" as const, hash: r.hash, ref: r.ref })),
        ...audit.map((r) => ({ kind: "AUDIT" as const, hash: r.hash, ref: r.ref })),
      ];
    });
  }

  /**
   * Jours ayant produit de l'activité, pas encore ancrés, strictement
   * antérieurs à `before` (exclu) et strictement postérieurs à la dernière
   * ancre. Deux bornes, deux raisons :
   *  - `before` : on n'ancre jamais le jour courant, qui n'est pas fini — la
   *    racine recalculée demain ne serait plus celle scellée aujourd'hui ;
   *  - la dernière ancre : la chaîne se construit dans l'ordre, un jour plus
   *    ancien ne peut plus s'y insérer sans la réécrire.
   */
  async pendingDays(tenantId: Id, before: string): Promise<string[]> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<{ day: string }[]>`
        WITH activity AS (
          SELECT (validated_at AT TIME ZONE 'UTC')::date AS day
            FROM journal_entry WHERE tenant_id = ${tenantId} AND status = 'VALIDATED' AND validated_at IS NOT NULL
          UNION
          SELECT (at AT TIME ZONE 'UTC')::date FROM audit_log WHERE tenant_id = ${tenantId}
        ),
        last_anchor AS (SELECT max(day) AS day FROM ledger_anchor WHERE tenant_id = ${tenantId})
        SELECT to_char(a.day, 'YYYY-MM-DD') AS day
          FROM activity a, last_anchor l
         WHERE a.day < ${before}::date
           AND (l.day IS NULL OR a.day > l.day)
         ORDER BY 1`;
      return rows.map((r) => r.day);
    });
  }

  /** Jours d'activité antérieurs à la dernière ancre et jamais ancrés : ils ne peuvent plus l'être, et il faut le savoir. */
  async unanchorableDays(tenantId: Id): Promise<string[]> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<{ day: string }[]>`
        WITH activity AS (
          SELECT (validated_at AT TIME ZONE 'UTC')::date AS day
            FROM journal_entry WHERE tenant_id = ${tenantId} AND status = 'VALIDATED' AND validated_at IS NOT NULL
          UNION
          SELECT (at AT TIME ZONE 'UTC')::date FROM audit_log WHERE tenant_id = ${tenantId}
        ),
        last_anchor AS (SELECT max(day) AS day FROM ledger_anchor WHERE tenant_id = ${tenantId})
        SELECT to_char(a.day, 'YYYY-MM-DD') AS day
          FROM activity a, last_anchor l
         WHERE l.day IS NOT NULL AND a.day < l.day
           AND NOT EXISTS (SELECT 1 FROM ledger_anchor x WHERE x.tenant_id = ${tenantId} AND x.day = a.day)
         ORDER BY 1`;
      return rows.map((r) => r.day);
    });
  }

  async lastAnchor(tenantId: Id): Promise<AnchorRecord | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<AnchorRow[]>`${anchorSelect(tx)} WHERE tenant_id = ${tenantId} ORDER BY day DESC LIMIT 1`;
      return rows[0] ? mapAnchor(rows[0]) : null;
    });
  }

  async getAnchor(tenantId: Id, day: string): Promise<AnchorRecord | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<AnchorRow[]>`${anchorSelect(tx)} WHERE tenant_id = ${tenantId} AND day = ${day}::date`;
      return rows[0] ? mapAnchor(rows[0]) : null;
    });
  }

  /** Ancre couvrant une date donnée : celle du jour même si elle existe. */
  async listAnchors(tenantId: Id, opts: { from?: string; to?: string; status?: AnchorStatus } = {}): Promise<AnchorRecord[]> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<AnchorRow[]>`${anchorSelect(tx)}
         WHERE tenant_id = ${tenantId}
           AND (${opts.from ?? null}::date IS NULL OR day >= ${opts.from ?? null}::date)
           AND (${opts.to ?? null}::date IS NULL OR day <= ${opts.to ?? null}::date)
           AND (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null})
         ORDER BY day`;
      return rows.map(mapAnchor);
    });
  }

  /**
   * Écrit une ancre. `ON CONFLICT DO NOTHING` sur (tenant, jour) : deux
   * exécutions concurrentes de la tâche quotidienne n'écrivent qu'une ancre, et
   * la seconde relit celle de la première plutôt que d'échouer.
   */
  async insertAnchor(anchor: DailyAnchor, builtBy?: Id): Promise<AnchorRecord> {
    return this.tx(anchor.tenantId, async (tx) => {
      await tx`
        INSERT INTO ledger_anchor (tenant_id, day, merkle_root, prev_anchor_hash, anchor_hash, leaf_count, entry_count, audit_count, built_by)
        VALUES (${anchor.tenantId}, ${anchor.day}::date, ${anchor.merkleRoot}, ${anchor.prevAnchorHash}, ${anchor.anchorHash},
                ${anchor.entryCount}, ${anchor.counts.entries}, ${anchor.counts.audit}, ${builtBy ?? null})
        ON CONFLICT (tenant_id, day) DO NOTHING`;
      const rows = await tx<AnchorRow[]>`${anchorSelect(tx)} WHERE tenant_id = ${anchor.tenantId} AND day = ${anchor.day}::date`;
      return mapAnchor(rows[0]!);
    });
  }

  async markPublished(tenantId: Id, day: string, publication: AnchorPublication): Promise<AnchorRecord> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<AnchorRow[]>`
        UPDATE ledger_anchor
           SET status = 'PUBLISHED', publisher = ${publication.publisher}, publication_ref = ${publication.reference},
               published_at = ${publication.publishedAt}::timestamptz, publication_proof = ${publication.proof ?? null},
               publication_error = NULL
         WHERE tenant_id = ${tenantId} AND day = ${day}::date AND status <> 'PUBLISHED'
        RETURNING id, tenant_id, to_char(day, 'YYYY-MM-DD') AS day, merkle_root, prev_anchor_hash, anchor_hash,
                  leaf_count, entry_count, audit_count, built_at, status, publisher, publication_ref,
                  published_at, publication_proof, publication_error`;
      if (rows[0]) return mapAnchor(rows[0]);
      const existing = await tx<AnchorRow[]>`${anchorSelect(tx)} WHERE tenant_id = ${tenantId} AND day = ${day}::date`;
      if (!existing[0]) throw new Error(`Aucune ancre au ${day} pour le dossier ${tenantId}`);
      return mapAnchor(existing[0]);
    });
  }

  async markFailed(tenantId: Id, day: string, error: string): Promise<void> {
    await this.tx(tenantId, async (tx) => {
      await tx`
        UPDATE ledger_anchor SET status = 'FAILED', publication_error = ${error.slice(0, 2000)}
         WHERE tenant_id = ${tenantId} AND day = ${day}::date AND status <> 'PUBLISHED'`;
    });
  }

  /** Jour (UTC) de validation d'une écriture, pour retrouver l'ancre qui la couvre. */
  async entryDay(tenantId: Id, entryId: Id): Promise<{ day: string; hash: string } | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<{ day: string; hash: string | null }[]>`
        SELECT to_char((validated_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, hash
          FROM journal_entry WHERE tenant_id = ${tenantId} AND id = ${entryId} AND status = 'VALIDATED'`;
      const row = rows[0];
      return row?.hash ? { day: row.day, hash: row.hash } : null;
    });
  }

  /** Jour (UTC) d'une ligne de piste d'audit. */
  async auditDay(tenantId: Id, auditId: string): Promise<{ day: string; hash: string } | null> {
    return this.tx(tenantId, async (tx) => {
      const rows = await tx<{ day: string; hash: string }[]>`
        SELECT to_char((at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, hash
          FROM audit_log WHERE tenant_id = ${tenantId} AND id = ${auditId}::bigint`;
      return rows[0] ?? null;
    });
  }

  /** Dossiers du schéma : la tâche quotidienne les parcourt tous. Hors RLS, réservé au compte d'exploitation. */
  async allTenantIds(): Promise<Id[]> {
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM company ORDER BY created_at`;
    return rows.map((r) => r.id);
  }
}

/** Reconstruit une ancre depuis les feuilles d'aujourd'hui et la compare à celle qui est scellée. */
export function recomputeAnchor(record: AnchorRecord, leaves: AnchorLeaf[]): { ok: boolean; recomputed: DailyAnchor } {
  const recomputed = buildDailyAnchor(record.tenantId, record.day, leaves, record.prevAnchorHash);
  return { ok: recomputed.anchorHash === record.anchorHash && recomputed.merkleRoot === record.merkleRoot, recomputed };
}
