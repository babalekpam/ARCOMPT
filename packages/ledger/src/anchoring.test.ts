import { describe, expect, it } from "vitest";
import { buildAnchor, dailyLeaves, MemoryAnchorPublisher, merkleProof, merkleRoot, verifyAnchorChain, verifyMerkleProof } from "./anchoring.js";
import type { JournalEntry } from "./types.js";

const leaves = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)];

describe("ancrage externe", () => {
  it("calcule une racine de Merkle déterministe et sensible à toute altération", () => {
    const root = merkleRoot(leaves);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(leaves)).toBe(root);
    expect(merkleRoot([...leaves.slice(0, 4), "f".repeat(64)])).not.toBe(root);
    expect(merkleRoot([])).toBe("");
  });

  it("produit et vérifie une preuve d'inclusion, y compris sur un niveau impair", () => {
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i);
      expect(verifyMerkleProof(proof)).toBe(true);
      expect(proof.root).toBe(merkleRoot(leaves));
    }
    const tampered = { ...merkleProof(leaves, 2), leaf: "0".repeat(64) };
    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("chaîne les ancres jour après jour et détecte une rupture", () => {
    const a1 = buildAnchor("t", "2025-03-01", leaves.slice(0, 2), null);
    const a2 = buildAnchor("t", "2025-03-02", leaves.slice(2), a1.anchorHash);
    expect(verifyAnchorChain([a2, a1])).toEqual({ ok: true });
    expect(verifyAnchorChain([a1, { ...a2, merkleRoot: "x" }])).toEqual({ ok: false, brokenAt: "2025-03-02" });
  });

  it("sélectionne les feuilles du jour dans un ordre canonique", () => {
    const mk = (journalCode: string, number: number, validatedAt: string, hash: string): JournalEntry =>
      ({ journalCode, number, validatedAt, hash, status: "VALIDATED" }) as unknown as JournalEntry;
    const entries = [mk("VT", 2, "2025-03-01T10:00:00Z", "h2"), mk("AC", 1, "2025-03-01T09:00:00Z", "h3"), mk("VT", 1, "2025-03-01T08:00:00Z", "h1"), mk("VT", 3, "2025-03-02T08:00:00Z", "h4")];
    expect(dailyLeaves(entries, "2025-03-01")).toEqual(["h3", "h1", "h2"]);
  });

  it("publie via un fournisseur interchangeable", async () => {
    const pub = new MemoryAnchorPublisher();
    const res = await pub.publish(buildAnchor("t", "2025-03-01", leaves, null));
    expect(res.reference).toBe("memory:t:2025-03-01");
    expect(pub.published).toHaveLength(1);
  });
});
