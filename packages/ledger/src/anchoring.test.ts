// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import {
  anchorImprint,
  anchorReceipt,
  buildAnchor,
  buildDailyAnchor,
  dailyLeaves,
  leafValue,
  MemoryAnchorPublisher,
  merkleProof,
  merkleRoot,
  orderLeaves,
  verifyAnchorChain,
  verifyMerkleProof,
  type AnchorLeaf,
} from "./anchoring.js";
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

describe("ancre du jour : les deux chaînes de hash", () => {
  const entry = (hash: string, ref: string): AnchorLeaf => ({ kind: "ENTRY", hash, ref });
  const audit = (hash: string, ref: string): AnchorLeaf => ({ kind: "AUDIT", hash, ref });

  it("scelle les écritures ET la piste d'audit", () => {
    const withAudit = buildDailyAnchor("t", "2025-03-01", [entry("h1", "e1"), audit("h2", "1")], null);
    const entriesOnly = buildDailyAnchor("t", "2025-03-01", [entry("h1", "e1")], null);
    expect(withAudit.counts).toEqual({ entries: 1, audit: 1 });
    expect(withAudit.entryCount).toBe(2);
    // Retirer une ligne d'audit change la racine : c'est ce qui rend la piste
    // d'audit couverte par l'ancre, et pas seulement voisine d'elle.
    expect(withAudit.merkleRoot).not.toBe(entriesOnly.merkleRoot);
  });

  it("ne laisse pas un hash d'audit se faire passer pour un hash d'écriture", () => {
    expect(leafValue({ kind: "ENTRY", hash: "h" })).not.toBe(leafValue({ kind: "AUDIT", hash: "h" }));
    const asEntry = buildDailyAnchor("t", "2025-03-01", [entry("h", "e1")], null);
    const asAudit = buildDailyAnchor("t", "2025-03-01", [audit("h", "1")], null);
    expect(asEntry.merkleRoot).not.toBe(asAudit.merkleRoot);
  });

  it("remet toujours les feuilles dans le même ordre, quelle que soit la lecture", () => {
    const shuffled = [audit("h2", "1"), entry("h1", "e1"), audit("h3", "2")];
    expect(orderLeaves(shuffled).map((l) => l.ref)).toEqual(["e1", "1", "2"]);
    expect(buildDailyAnchor("t", "2025-03-01", shuffled, null).anchorHash).toBe(
      buildDailyAnchor("t", "2025-03-01", [entry("h1", "e1"), audit("h2", "1"), audit("h3", "2")], null).anchorHash,
    );
  });

  it("produit un reçu reproductible, sans rien de variable", () => {
    const a = buildDailyAnchor("t", "2025-03-01", [entry("h1", "e1")], null);
    expect(anchorReceipt(a)).toBe(anchorReceipt(a));
    expect(anchorReceipt(a)).toContain("ARCOMPT-ANCHOR-v1");
    expect(anchorReceipt(a)).toContain(`anchor=${a.anchorHash}`);
    expect(anchorReceipt(a)).toContain("prev=GENESIS");
    expect(anchorImprint(a)).toMatch(/^[0-9a-f]{64}$/);
    // Le reçu du lendemain diffère : il porte le chaînage.
    const b = buildDailyAnchor("t", "2025-03-02", [entry("h2", "e2")], a.anchorHash);
    expect(anchorImprint(b)).not.toBe(anchorImprint(a));
  });

  it("chaîne les ancres mixtes comme les autres", () => {
    const a1 = buildDailyAnchor("t", "2025-03-01", [entry("h1", "e1"), audit("h2", "1")], null);
    const a2 = buildDailyAnchor("t", "2025-03-02", [audit("h3", "2")], a1.anchorHash);
    expect(verifyAnchorChain([a1, a2])).toEqual({ ok: true });
    expect(verifyAnchorChain([a1, { ...a2, entryCount: 99 }])).toEqual({ ok: false, brokenAt: "2025-03-02" });
  });
});
