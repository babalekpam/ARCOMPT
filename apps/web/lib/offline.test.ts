import { describe, expect, it } from "vitest";
import {
  createDraftQueue,
  createRecentStore,
  generateClientId,
  keyIdFor,
  loadOrCreateCipher,
  MemoryStore,
  RetryableError,
  sanitizeDraftInput,
  WebCryptoCipher,
  type EntryDraftInput,
  type StoredDraft,
} from "./offline";

const material = new TextEncoder().encode("session-material-A");
const otherMaterial = new TextEncoder().encode("session-material-B");

const draft: EntryDraftInput = {
  journalCode: "OD",
  date: "2025-05-01",
  label: "Test hors ligne",
  source: "MANUAL",
  lines: [
    { accountNumber: "6041", debit: "1000.0000" },
    { accountNumber: "521", credit: "1000.0000" },
  ],
};

async function setup() {
  const store = new MemoryStore<StoredDraft>();
  const cipher = await WebCryptoCipher.fromMaterial(material);
  const queue = createDraftQueue({ store, cipher, now: () => new Date("2025-05-01T10:00:00Z") });
  return { store, cipher, queue };
}

describe("file de brouillons hors ligne", () => {
  it("génère des UUID v4 côté client", () => {
    expect(generateClientId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generateClientId()).not.toBe(generateClientId());
  });

  it("chiffre le contenu : rien de lisible dans le store", async () => {
    const { store, queue } = await setup();
    const q = await queue.enqueue(draft);
    const raw = await store.get(q.clientId);
    expect(raw).toBeDefined();
    expect(JSON.stringify(raw)).not.toContain("Test hors ligne");
    expect(JSON.stringify(raw)).not.toContain("6041");
    expect(raw!.keyId).toHaveLength(16);
  });

  it("liste et déchiffre avec la même clé de session", async () => {
    const { queue } = await setup();
    await queue.enqueue(draft, "11111111-1111-4111-8111-111111111111");
    const list = await queue.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.clientId).toBe("11111111-1111-4111-8111-111111111111");
    expect(list[0]!.input?.label).toBe("Test hors ligne");
    expect(await queue.count()).toBe(1);
  });

  it("ne déchiffre pas les brouillons d'une autre session", async () => {
    const { store, queue } = await setup();
    await queue.enqueue(draft);
    const other = createDraftQueue({ store, cipher: await WebCryptoCipher.fromMaterial(otherMaterial) });
    const list = await other.list();
    expect(list[0]!.input).toBeUndefined();
    const replay = await other.replay(async () => undefined);
    expect(replay.sent).toEqual([]);
    expect(replay.failed[0]!.retryable).toBe(false);
  });

  it("rejoue en brouillon seulement, avec clientId, sans tenant, et retire les envoyés", async () => {
    const { queue } = await setup();
    const withTenant = { ...draft, tenantId: "leak", lines: [{ ...draft.lines[0]!, tenantId: "leak" }, draft.lines[1]!] } as unknown as EntryDraftInput;
    const q = await queue.enqueue(withTenant);
    const sent: unknown[] = [];
    const result = await queue.replay(async (body) => {
      sent.push(body);
    });
    expect(result.sent).toEqual([q.clientId]);
    expect(sent).toHaveLength(1);
    const body = sent[0] as Record<string, unknown>;
    expect(body.clientId).toBe(q.clientId);
    expect(body.validate).toBe(false);
    expect(JSON.stringify(body)).not.toContain("leak");
    expect(await queue.count()).toBe(0);
  });

  it("arrête le rejeu sur erreur réseau et garde l'erreur métier en file", async () => {
    const { queue } = await setup();
    const a = await queue.enqueue({ ...draft, label: "A" }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const b = await queue.enqueue({ ...draft, label: "B" }, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const first = await queue.replay(async (body) => {
      if (body.clientId === a.clientId) throw new RetryableError("réseau");
    });
    expect(first.sent).toEqual([]);
    expect(first.failed).toHaveLength(1); // B n'a pas été tenté
    expect(await queue.count()).toBe(2);

    const second = await queue.replay(async (body) => {
      if (body.clientId === b.clientId) throw new Error("VALIDATION");
    });
    expect(second.sent).toEqual([a.clientId]);
    expect(second.failed).toEqual([{ clientId: b.clientId, message: "VALIDATION", retryable: false }]);
    const remaining = await queue.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.lastError).toBe("VALIDATION");
    expect(remaining[0]!.attempts).toBe(1);
  });

  it("sanitizeDraftInput impose source MANUAL et ne garde que les champs attendus", () => {
    const clean = sanitizeDraftInput({ ...draft, source: "AI" as "MANUAL", reference: "" });
    expect(clean.source).toBe("MANUAL");
    expect("reference" in clean).toBe(false);
    expect(Object.keys(clean.lines[0]!)).toEqual(["accountNumber", "debit"]);
  });
});

describe("clé de session", () => {
  it("dérive un identifiant stable et une clé non extractable, réutilisée depuis le store", async () => {
    const keys = new MemoryStore<CryptoKey>();
    const c1 = await loadOrCreateCipher(keys, material);
    const c2 = await loadOrCreateCipher(keys, material);
    expect(c1.keyId).toBe(await keyIdFor(material));
    expect(c2.keyId).toBe(c1.keyId);
    expect((await keys.get(c1.keyId))!.extractable).toBe(false);
    const enc = await c1.encrypt("secret");
    expect(await c2.decrypt(enc.iv, enc.data)).toBe("secret");
    // Une nouvelle session purge l'ancienne clé.
    const c3 = await loadOrCreateCipher(keys, otherMaterial);
    expect(await keys.keys()).toEqual([c3.keyId]);
  });

  it("l'historique local est chiffré et lié à la clé", async () => {
    const store = new MemoryStore<{ iv: string; data: string }>();
    const cipher = await WebCryptoCipher.fromMaterial(material);
    const recent = createRecentStore({ store, cipher });
    await recent.upsert({ id: "e1", journalCode: "VT", date: "2025-03-15", label: "Facture Client Alpha", status: "VALIDATED", number: 1, totalDebit: "1180000.0000", updatedAt: "2025-03-15T00:00:00Z" });
    expect(JSON.stringify(await store.get(`recent:${cipher.keyId}`))).not.toContain("Alpha");
    expect((await recent.list())[0]!.label).toBe("Facture Client Alpha");
    await recent.remove("e1");
    expect(await recent.list()).toEqual([]);
  });
});
