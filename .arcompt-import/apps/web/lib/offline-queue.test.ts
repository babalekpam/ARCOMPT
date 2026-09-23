// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { MemoryStore, WebCryptoCipher, type Cipher } from "./offline";
import {
  collectLocalRefs,
  createOperationQueue,
  isLocalId,
  localId,
  resolveLocalRefs,
  UnresolvedDependencyError,
  type OperationKind,
  type StoredOperation,
} from "./offline-queue";
import { RetryableError } from "./offline";

/**
 * Ce que ces tests fixent, c'est le contrat qui rend la file utilisable sur le
 * terrain : l'ordre de rejeu, la substitution des références locales, et le
 * traitement distinct d'une coupure et d'un refus.
 */
async function cipherFor(seed = "graine-de-test"): Promise<Cipher> {
  return WebCryptoCipher.fromMaterial(new TextEncoder().encode(seed));
}

function queueWith(cipher: Cipher, clock: { t: number }) {
  return createOperationQueue({
    store: new MemoryStore<StoredOperation>(),
    links: new MemoryStore<{ iv: string; data: string }>(),
    cipher,
    now: () => new Date(Date.UTC(2025, 0, 1, 0, 0, clock.t++)),
  });
}

describe("Références locales", () => {
  it("substitue une référence connue et refuse d'en inventer une", () => {
    const ref = localId("11111111-1111-4111-8111-111111111111");
    expect(isLocalId(ref)).toBe(true);
    const body = { partnerId: ref, lines: [{ productId: ref }, { productId: "réel" }] };

    expect(resolveLocalRefs(body, { [ref]: "serveur-1" })).toEqual({
      partnerId: "serveur-1",
      lines: [{ productId: "serveur-1" }, { productId: "réel" }],
    });

    // Sans résolution, la file ne doit PAS envoyer « local:… » au serveur :
    // il le prendrait pour un identifiant invalide, ou pire, pour du texte.
    expect(() => resolveLocalRefs(body, {})).toThrow(UnresolvedDependencyError);
  });

  it("recense les références présentes dans un corps imbriqué", () => {
    const a = localId("a1111111-1111-4111-8111-111111111111");
    const b = localId("b1111111-1111-4111-8111-111111111111");
    expect([...collectLocalRefs({ x: a, y: [{ z: b }, { z: a }] })]).toEqual([a, b]);
  });
});

describe("File d'opérations", () => {
  it("rejoue dans l'ordre de création et relie l'identifiant local au serveur", async () => {
    const cipher = await cipherFor();
    const clock = { t: 0 };
    const queue = queueWith(cipher, clock);

    const ref = localId();
    await queue.enqueue("partner.create", { name: "Client A", type: "CUSTOMER" }, { produces: ref });
    await queue.enqueue("sales.draft", { partnerId: ref, kind: "INVOICE" });

    const seen: Array<{ kind: OperationKind; body: Record<string, unknown> }> = [];
    const result = await queue.replay(async ({ kind, body }) => {
      seen.push({ kind, body });
      return { id: kind === "partner.create" ? "partenaire-serveur" : "vente-serveur" };
    });

    expect(result.sent).toHaveLength(2);
    expect(seen[0]!.kind).toBe("partner.create");
    // La facture est partie avec l'identifiant SERVEUR du tiers, pas le local.
    expect(seen[1]!.body.partnerId).toBe("partenaire-serveur");
    expect(await queue.count()).toBe(0);
    expect(await queue.resolved()).toEqual({ [ref]: "partenaire-serveur" });
  });

  it("chaque envoi porte son identifiant de rejeu", async () => {
    const cipher = await cipherFor();
    const queue = queueWith(cipher, { t: 0 });
    const op = await queue.enqueue("partner.create", { name: "B" });
    let sentClientId: unknown;
    await queue.replay(async ({ body }) => {
      sentClientId = body.clientId;
      return { id: "x" };
    });
    expect(sentClientId).toBe(op.clientId);
  });

  it("une coupure arrête le rejeu et ne perd rien", async () => {
    const cipher = await cipherFor();
    const queue = queueWith(cipher, { t: 0 });
    await queue.enqueue("partner.create", { name: "A" });
    await queue.enqueue("partner.create", { name: "B" });

    let calls = 0;
    const result = await queue.replay(async () => {
      calls++;
      throw new RetryableError("réseau indisponible");
    });

    expect(calls).toBe(1); // on n'insiste pas : le réseau est tombé
    expect(result.failed[0]!.retryable).toBe(true);
    expect(await queue.count()).toBe(2);
  });

  it("un refus métier laisse l'élément en file, marqué, et laisse passer les suivants", async () => {
    const cipher = await cipherFor();
    const queue = queueWith(cipher, { t: 0 });
    await queue.enqueue("partner.create", { name: "" });
    await queue.enqueue("partner.create", { name: "Valide" });

    const result = await queue.replay(async ({ body }) => {
      if (!body.name) throw new Error("Nom requis");
      return { id: "ok" };
    });

    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.retryable).toBe(false);
    expect(await queue.countBlocked()).toBe(1);

    const [blocked] = await queue.list();
    expect(blocked!.lastError).toBe("Nom requis");
    expect(blocked!.attempts).toBe(1);

    // `retry` efface la marque pour qu'un prochain rejeu retente réellement.
    await queue.retry(blocked!.clientId);
    expect(await queue.countBlocked()).toBe(0);
  });

  it("une dépendance jamais créée met l'élément en attente, sans l'envoyer", async () => {
    const cipher = await cipherFor();
    const queue = queueWith(cipher, { t: 0 });
    await queue.enqueue("sales.draft", { partnerId: localId(), kind: "INVOICE" });

    let sent = 0;
    const result = await queue.replay(async () => {
      sent++;
      return { id: "ne devrait pas arriver" };
    });

    expect(sent).toBe(0);
    expect(result.waiting).toHaveLength(1);
    const [row] = await queue.list();
    expect(row!.waiting).toBe(true);
  });

  it("un changement de clé de session rend le contenu illisible sans le faire disparaître", async () => {
    const store = new MemoryStore<StoredOperation>();
    const links = new MemoryStore<{ iv: string; data: string }>();
    const first = await cipherFor("session-1");
    await createOperationQueue({ store, links, cipher: first }).enqueue("partner.create", { name: "Secret" });

    const second = await cipherFor("session-2");
    const queue = createOperationQueue({ store, links, cipher: second });
    const [row] = await queue.list();
    expect(row!.input).toBeUndefined(); // illisible, mais toujours là et signalé
    const result = await queue.replay(async () => ({ id: "x" }));
    expect(result.failed[0]!.message).toContain("clé de session");
  });
});
