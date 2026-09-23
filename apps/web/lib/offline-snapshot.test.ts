// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { MemoryStore, WebCryptoCipher } from "./offline";
import { createSnapshotStore, readWithSnapshot, SNAPSHOT_STALE_MS, type StoredSnapshot } from "./offline-snapshot";

const cipherFor = (seed: string) => WebCryptoCipher.fromMaterial(new TextEncoder().encode(seed));

describe("Cliché de référence", () => {
  it("le réseau gagne toujours, et met le cliché à jour au passage", async () => {
    const snapshots = createSnapshotStore({ store: new MemoryStore<StoredSnapshot>(), cipher: await cipherFor("s") });
    const out = await readWithSnapshot("partners", async () => ({ partners: [{ id: "1" }] }), snapshots);
    expect(out.fromSnapshot).toBe(false);
    expect((await snapshots.read<{ partners: unknown[] }>("partners"))!.data.partners).toHaveLength(1);
  });

  it("une coupure sert le cliché, en le disant", async () => {
    const snapshots = createSnapshotStore({ store: new MemoryStore<StoredSnapshot>(), cipher: await cipherFor("s") });
    await snapshots.write("accounts", { accounts: [{ number: "411" }] });
    const out = await readWithSnapshot<{ accounts: unknown[] }>("accounts", async () => {
      throw new Error("réseau indisponible");
    }, snapshots);
    expect(out.fromSnapshot).toBe(true);
    expect(out.data.accounts).toHaveLength(1);
  });

  it("un cliché vieux est signalé périmé, pas caché", async () => {
    const store = new MemoryStore<StoredSnapshot>();
    const cipher = await cipherFor("s");
    const old = createSnapshotStore({ store, cipher, now: () => new Date(Date.UTC(2025, 0, 1)) });
    await old.write("accounts", { accounts: [] });

    const later = new Date(Date.UTC(2025, 0, 1) + SNAPSHOT_STALE_MS + 1000);
    const now = createSnapshotStore({ store, cipher, now: () => later });
    const out = await readWithSnapshot("accounts", async () => {
      throw new Error("réseau indisponible");
    }, now);
    expect(out.stale).toBe(true);
  });

  it("sans cliché, l'erreur réseau remonte : un écran vide ferait croire qu'il n'y a rien", async () => {
    const snapshots = createSnapshotStore({ store: new MemoryStore<StoredSnapshot>(), cipher: await cipherFor("s") });
    await expect(
      readWithSnapshot("partners", async () => {
        throw new Error("réseau indisponible");
      }, snapshots),
    ).rejects.toThrow("réseau indisponible");
  });

  it("un cliché écrit sous une autre clé de session n'est pas servi", async () => {
    const store = new MemoryStore<StoredSnapshot>();
    await createSnapshotStore({ store, cipher: await cipherFor("session-1") }).write("partners", { partners: [{ id: "1" }] });
    const other = createSnapshotStore({ store, cipher: await cipherFor("session-2") });
    expect(await other.read("partners")).toBeNull();
  });
});
