// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { buildCorrection, confidenceTone, defaultAnomalyPeriod, documentStatusTone, formatBytes, formatConfidence, groupsToDocuments, isAcceptedFile, proposalTotals, routeTone, toEditableLines } from "./helpers";
import type { DocumentRecord, ProposalRecord, ReviewQueueGroup } from "./types";

const doc = (id: string, createdAt: string): DocumentRecord => ({
  id,
  tenantId: "t",
  entryId: null,
  storageKey: `k/${id}`,
  sha256: "x",
  mimeType: "image/jpeg",
  sizeBytes: 10,
  filename: `${id}.jpg`,
  source: "UPLOAD",
  status: "PROPOSED",
  extracted: null,
  uploadedBy: "u",
  createdAt,
});

const proposal = (id: string, documentId: string, status: ProposalRecord["status"], createdAt: string): ProposalRecord => ({
  id,
  tenantId: "t",
  documentId,
  source: "UPLOAD",
  kind: "ENTRY",
  extraction: null,
  proposal: { journal_code: "AC", date: "2025-01-10", label: "x", lines: [], confidence: 0.9, rationale: "", alternatives: [] },
  confidence: 0.9,
  guardIssues: [],
  route: "REVIEW_QUEUE",
  status,
  decidedBy: null,
  decidedAt: null,
  entryId: null,
  correction: null,
  createdAt,
});

describe("documents helpers", () => {
  it("formate la confiance et choisit la tonalité", () => {
    expect(formatConfidence(0.916)).toBe("92 %");
    expect(formatConfidence(1.4)).toBe("100 %");
    expect(formatConfidence(undefined)).toBe("—");
    expect(confidenceTone(0.9)).toBe("success");
    expect(confidenceTone(0.7)).toBe("warning");
    expect(confidenceTone(0.2)).toBe("danger");
    expect(routeTone("ONE_TAP_VALIDATION")).toBe("success");
    expect(routeTone("REJECTED")).toBe("danger");
    expect(documentStatusTone("POSTED")).toBe("success");
    expect(documentStatusTone("NEEDS_OCR")).toBe("warning");
  });

  it("formate les tailles et filtre les fichiers acceptés", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(2048)).toBe("2 Ko");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3,0 Mo");
    expect(isAcceptedFile({ type: "image/png", name: "a.png", size: 10 })).toBe(true);
    expect(isAcceptedFile({ type: "", name: "facture.PDF", size: 10 })).toBe(true);
    expect(isAcceptedFile({ type: "text/plain", name: "a.txt", size: 10 })).toBe(false);
    expect(isAcceptedFile({ type: "image/png", name: "a.png", size: 30 * 1024 * 1024 })).toBe(false);
  });

  it("dérive la liste des pièces des groupes de revue (dédoublonnée, triée, dernière proposition)", () => {
    const d1 = doc("d1", "2025-01-01T00:00:00Z");
    const d2 = doc("d2", "2025-02-01T00:00:00Z");
    const groups: ReviewQueueGroup[] = [
      { document: d1, proposals: [proposal("p1", "d1", "PENDING", "2025-01-02T00:00:00Z")] },
      { document: null, proposals: [proposal("p0", "", "PENDING", "2025-01-03T00:00:00Z")] },
      { document: d2, proposals: [proposal("p2", "d2", "REJECTED", "2025-02-02T00:00:00Z")] },
      { document: d1, proposals: [proposal("p3", "d1", "PENDING", "2025-01-05T00:00:00Z")] },
    ];
    const list = groupsToDocuments(groups);
    expect(list.map((x) => x.document.id)).toEqual(["d2", "d1"]);
    expect(list[1]?.latest?.id).toBe("p3");
    expect(list[1]?.pendingCount).toBe(2);
    expect(list[0]?.pendingCount).toBe(0);
  });

  it("calcule les totaux et valide une correction", () => {
    expect(proposalTotals([{ debit: "100" }, { credit: "100" }])).toEqual({ debit: "100.0000", credit: "100.0000", balanced: true });
    const lines = toEditableLines([
      { account_number: "6041", debit: "118", label: "Achat" },
      { account_number: "4011", credit: "118" },
    ]);
    const ok = buildCorrection(lines);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.lines).toEqual([{ account_number: "6041", debit: "118.0000", label: "Achat" }, { account_number: "4011", credit: "118.0000" }]);
    expect(buildCorrection([lines[0]!])).toEqual({ ok: false, error: "MIN_LINES" });
    expect(buildCorrection([{ ...lines[0]!, account_number: "0" }, lines[1]!])).toEqual({ ok: false, error: "ACCOUNT" });
    expect(buildCorrection([{ ...lines[0]!, credit: "5" }, lines[1]!])).toEqual({ ok: false, error: "AMOUNT" });
    expect(buildCorrection([{ ...lines[0]!, debit: "100" }, lines[1]!])).toEqual({ ok: false, error: "UNBALANCED" });
  });

  it("propose la période d'anomalies par défaut", () => {
    expect(defaultAnomalyPeriod("2025-09-19")).toEqual({ from: "2025-01-01", to: "2025-09-19" });
  });
});
