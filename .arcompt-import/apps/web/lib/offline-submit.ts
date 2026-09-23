// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
"use client";
/**
 * Création « en ligne si possible, en file sinon » (docs/OFFLINE.md).
 *
 * Le point délicat n'est pas la coupure franche — `navigator.onLine` la dit —
 * mais la coupure EN COURS D'ENVOI : la requête part, le réseau tombe, et
 * personne ne sait si le serveur a écrit. C'est exactement le cas que le
 * `clientId` traite : il est tiré AVANT l'envoi, il part avec la requête, et il
 * part encore avec le rejeu. Le serveur reconnaît le second envoi et rend la
 * réponse du premier au lieu de créer un doublon (apps/api/src/idempotency.ts).
 *
 * L'identifiant local (`produces`) sert à l'autre moitié du problème : une
 * facture saisie juste après un client créé hors ligne doit pouvoir le
 * désigner. Elle le désigne par son identifiant local, et le rejeu substitue
 * l'identifiant serveur.
 */
import { ApiError, NetworkError } from "./api-client";
import { generateClientId } from "./offline";
import { getOfflineServices } from "./offline-browser";
import { localId, type OperationKind } from "./offline-queue";
import { notifySyncChanged } from "./offline-sync";

export interface QueuedOutcome {
  queued: true;
  clientId: string;
  /** Identifiant local attribué, quand d'autres saisies peuvent le désigner. */
  localRef: string | null;
}

export interface SentOutcome<T> {
  queued: false;
  result: T;
}

export type SubmitOutcome<T> = QueuedOutcome | SentOutcome<T>;

/** Un envoi interrompu se rejoue ; un refus métier ne se rejoue pas. */
function isInterruption(e: unknown): boolean {
  return e instanceof NetworkError || (e instanceof ApiError && e.status >= 500);
}

export async function createOrQueue<T>(
  kind: OperationKind,
  input: Record<string, unknown>,
  send: (body: Record<string, unknown>) => Promise<T>,
  opts: { producesLocalRef?: boolean } = {},
): Promise<SubmitOutcome<T>> {
  const clientId = generateClientId();
  const localRef = opts.producesLocalRef ? localId(clientId) : null;

  const enqueue = async (): Promise<QueuedOutcome> => {
    const svc = await getOfflineServices();
    if (!svc) throw new NetworkError("mode hors ligne indisponible sur cet appareil");
    await svc.operations.enqueue(kind, input, { clientId, ...(localRef ? { produces: localRef } : {}) });
    notifySyncChanged();
    return { queued: true, clientId, localRef };
  };

  // Coupure déjà connue : inutile de faire attendre l'utilisateur sur un
  // délai d'expiration réseau.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return enqueue();

  try {
    return { queued: false, result: await send({ ...input, clientId }) };
  } catch (e) {
    if (isInterruption(e)) return enqueue();
    throw e; // refus métier : l'utilisateur doit le voir, pas le retrouver en file
  }
}
