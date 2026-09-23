// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { withTenant, type Db } from "@arcompt/db";

/**
 * Idempotence des créations rejouées depuis la file hors ligne
 * (packages/db/migrations/0015_idempotency.sql, docs/OFFLINE.md).
 *
 * Un appareil hors réseau met ses créations en file avec un `clientId` tiré
 * localement. Au retour du réseau, la file rejoue. Un rejeu est une requête qui
 * a peut-être déjà abouti : sans garde, on crée deux fois le même tiers.
 *
 * Le contrat tient en trois cas :
 *   - `clientId` inconnu       → l'opération s'exécute, sa réponse est conservée ;
 *   - `clientId` connu, même corps → la réponse conservée est renvoyée telle
 *     quelle, rien ne s'exécute (`replayed: true`) ;
 *   - `clientId` connu, corps différent → 409. Ce n'est pas un rejeu mais une
 *     collision : servir l'ancienne réponse ferait croire à l'utilisateur que sa
 *     nouvelle saisie est enregistrée alors qu'elle est perdue.
 *
 * Deux chemins, parce que les routes n'ont pas toutes la même forme :
 *
 *   - `withIdempotency` : la route possède sa transaction (SQL direct sous
 *     `withTenant`). La ressource et sa trace s'écrivent ensemble ou pas du
 *     tout, et un verrou consultatif sérialise deux rejeux concurrents.
 *
 *   - `withIdempotencyAround` : la route délègue à un service qui ouvre sa
 *     propre transaction. La trace est alors posée AVANT en `PENDING`, puis
 *     complétée. Une réservation abandonnée par un échec est retirée : un échec
 *     ne condamne pas l'identifiant. La fenêtre résiduelle — l'opération
 *     réussit, la complétion échoue — laisse une réservation `PENDING` qui
 *     répondra 409 au rejeu : l'utilisateur est renvoyé vers la liste plutôt
 *     que servi d'un doublon silencieux.
 */

export class IdempotencyConflictError extends Error {
  override name = "IdempotencyConflictError";
  constructor(readonly clientId: string) {
    super(`L'identifiant de rejeu ${clientId} a déjà servi pour une autre requête`);
  }
}

export interface IdempotentResult<T> {
  body: T;
  status: number;
  /** Vrai si la réponse vient du registre : rien n'a été exécuté cette fois. */
  replayed: boolean;
  resourceId: string | null;
}

export interface RunOutcome<T> {
  body: T;
  /** Identifiant de la ressource créée, conservé pour relier l'id local à l'id serveur. */
  resourceId?: string | null;
  status?: number;
}

/**
 * Empreinte stable du corps : clés d'objet triées à tous les niveaux, tableaux
 * dans leur ordre (l'ordre des lignes d'un document est signifiant). `undefined`
 * est traité comme absent, pour que `{a:1}` et `{a:1,b:undefined}` aient la même
 * empreinte — JSON.stringify les rend déjà identiques côté client.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestHash(operation: string, body: unknown): string {
  return createHash("sha256").update(`${operation}\n${canonicalJson(body)}`).digest("hex");
}

export interface IdempotencyArgs {
  tx: Sql;
  tenantId: string;
  userId?: string | null;
  /** Absent : l'opération s'exécute sans trace, comme avant. */
  clientId?: string | undefined;
  /** Opération logique, contrainte à `domaine.action` par la base. */
  operation: string;
  /** Corps de la requête, tel que validé. */
  body: unknown;
  resourceKind: string;
}

export async function withIdempotency<T>(args: IdempotencyArgs, run: () => Promise<RunOutcome<T>>): Promise<IdempotentResult<T>> {
  if (!args.clientId) {
    const out = await run();
    return { body: out.body, status: out.status ?? 201, replayed: false, resourceId: out.resourceId ?? null };
  }

  const tx = args.tx;
  const hash = requestHash(args.operation, args.body);
  // Sérialise les rejeux concurrents du même identifiant jusqu'à la fin de la
  // transaction. hashtextextended prend une graine ; le couple dossier/client
  // suffit à répartir.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${args.tenantId}:${args.clientId}`}, 0))`;

  const [existing] = await tx<Array<{ request_hash: string; state: string; response: unknown; status_code: number | null; resource_id: string | null }>>`
    SELECT request_hash, state, response, status_code, resource_id
      FROM idempotency_record
     WHERE tenant_id = ${args.tenantId} AND client_id = ${args.clientId}`;
  if (existing) {
    if (existing.request_hash !== hash) throw new IdempotencyConflictError(args.clientId);
    if (existing.state === "PENDING") throw new IdempotencyInFlightError(args.clientId);
    return { body: existing.response as T, status: existing.status_code ?? 200, replayed: true, resourceId: existing.resource_id };
  }

  const out = await run();
  const status = out.status ?? 201;
  // `tx.json()` et non `JSON.stringify(...)::jsonb` : postgres.js ré-encode une
  // chaîne passée à une colonne jsonb, et le rejeu rendait alors une CHAÎNE JSON
  // là où le premier appel avait rendu un objet. Deux réponses différentes pour
  // la même requête, ce que l'idempotence est précisément censée exclure.
  await tx`
    INSERT INTO idempotency_record (tenant_id, client_id, operation, request_hash, resource_kind, resource_id, state, response, status_code, created_by, completed_at)
    VALUES (${args.tenantId}, ${args.clientId}, ${args.operation}, ${hash}, ${args.resourceKind}, ${out.resourceId ?? null},
            'COMPLETED', ${tx.json(out.body as never)}, ${status}, ${args.userId ?? null}, now())`;
  return { body: out.body, status, replayed: false, resourceId: out.resourceId ?? null };
}

/** Lancée quand un rejeu arrive alors que le premier envoi est encore en cours. */
export class IdempotencyInFlightError extends Error {
  override name = "IdempotencyInFlightError";
  constructor(readonly clientId: string) {
    super(`Un envoi portant l'identifiant ${clientId} est déjà en cours`);
  }
}

export interface AroundArgs {
  db: Db;
  ctx: { tenantId: string; userId?: string; organizationId?: string };
  clientId?: string | undefined;
  operation: string;
  body: unknown;
  resourceKind: string;
}

/**
 * Variante deux temps pour les routes qui délèguent à un service possédant sa
 * propre transaction. `run` reçoit la garantie qu'aucun autre rejeu du même
 * `clientId` ne s'exécute en parallèle.
 */
export async function withIdempotencyAround<T>(args: AroundArgs, run: () => Promise<T>, resourceIdOf?: (body: T) => string | null): Promise<IdempotentResult<T>> {
  if (!args.clientId) {
    const body = await run();
    return { body, status: 201, replayed: false, resourceId: resourceIdOf?.(body) ?? null };
  }
  const clientId = args.clientId;
  const hash = requestHash(args.operation, args.body);

  // 1. Réservation. ON CONFLICT DO NOTHING : le perdant d'une course lit la
  //    ligne du gagnant au lieu d'écraser sa trace.
  const reserved = await withTenant(args.db, args.ctx, async (tx) => {
    const inserted = await tx`
      INSERT INTO idempotency_record (tenant_id, client_id, operation, request_hash, resource_kind, state, created_by)
      VALUES (${args.ctx.tenantId}, ${clientId}, ${args.operation}, ${hash}, ${args.resourceKind}, 'PENDING', ${args.ctx.userId ?? null})
      ON CONFLICT (tenant_id, client_id) DO NOTHING
      RETURNING client_id`;
    if (inserted.length > 0) return null;
    const [row] = await tx<Array<{ request_hash: string; state: string; response: unknown; status_code: number | null; resource_id: string | null }>>`
      SELECT request_hash, state, response, status_code, resource_id
        FROM idempotency_record WHERE tenant_id = ${args.ctx.tenantId} AND client_id = ${clientId}`;
    return row ?? null;
  });

  if (reserved) {
    if (reserved.request_hash !== hash) throw new IdempotencyConflictError(clientId);
    if (reserved.state === "PENDING") throw new IdempotencyInFlightError(clientId);
    return { body: reserved.response as T, status: reserved.status_code ?? 200, replayed: true, resourceId: reserved.resource_id };
  }

  // 2. Exécution. Un échec retire la réservation, sans quoi l'identifiant
  //    resterait bloqué en PENDING pour toujours.
  let body: T;
  try {
    body = await run();
  } catch (e) {
    await withTenant(args.db, args.ctx, (tx) =>
      tx`DELETE FROM idempotency_record WHERE tenant_id = ${args.ctx.tenantId} AND client_id = ${clientId} AND state = 'PENDING'`,
    ).catch(() => undefined); // le retrait est un confort : son échec ne doit pas masquer l'erreur métier
    throw e;
  }

  // 3. Complétion.
  const resourceId = resourceIdOf?.(body) ?? null;
  await withTenant(args.db, args.ctx, (tx) =>
    tx`UPDATE idempotency_record
          SET state = 'COMPLETED', response = ${tx.json(body as never)}, status_code = 201, completed_at = now(), resource_id = ${resourceId}
        WHERE tenant_id = ${args.ctx.tenantId} AND client_id = ${clientId} AND state = 'PENDING'`,
  );
  return { body, status: 201, replayed: false, resourceId };
}

/** Réponse HTTP commune aux deux chemins, pour ne pas la réécrire route par route. */
export function idempotencyErrorResponse(e: unknown): { status: 409; body: { error: { code: string; message: string } } } | null {
  if (e instanceof IdempotencyConflictError) return { status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: e.message } } };
  if (e instanceof IdempotencyInFlightError) return { status: 409, body: { error: { code: "IDEMPOTENCY_IN_FLIGHT", message: e.message } } };
  return null;
}
