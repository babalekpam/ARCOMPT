import type { Sql } from "postgres";

/** Aides SQL communes aux services du portail. */

type Row = Record<string, unknown>;

export function str(v: unknown): string {
  return String(v);
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** timestamptz / date → ISO ; postgres.js renvoie des Date pour ces types. */
export function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

export function int(v: unknown): number {
  return Number(v ?? 0);
}

/** Écrit une ligne d'audit (hash chaîné par trigger). À appeler dans une transaction tenant. */
export async function audit(
  tx: Sql,
  e: { tenantId: string; userId?: string | null; action: string; entity: string; entityId: string; before?: unknown; after?: unknown },
): Promise<void> {
  await tx`
    INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, before, after)
    VALUES (${e.tenantId}, ${e.userId ?? null}, ${e.action}, ${e.entity}, ${e.entityId},
            ${e.before === undefined ? null : tx.json(e.before as never)}, ${e.after === undefined ? null : tx.json(e.after as never)})`;
}

export type { Row };
