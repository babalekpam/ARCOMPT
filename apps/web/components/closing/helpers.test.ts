import { describe, expect, it } from "vitest";
import { allowedTransitions, checklistProgress, checklistTone, evidenceNote, periodCode, periodTone, WORKFLOW_EDGES } from "./helpers";

describe("closing helpers", () => {
  it("reflète la machine à états serveur", () => {
    expect(WORKFLOW_EDGES.map((e) => `${e.from}>${e.to}`)).toEqual(["TENUE>REVISION", "REVISION>TENUE", "REVISION>ETATS", "ETATS>VISA", "VISA>REVISION", "VISA>DEPOT", "DEPOT>VERROUILLE"]);
    expect(allowedTransitions("VISA").map((e) => e.to)).toEqual(["REVISION", "DEPOT"]);
    expect(allowedTransitions("VERROUILLE")).toEqual([]);
    expect(allowedTransitions("DEPOT")[0]?.receiptRequired).toBe(true);
    expect(allowedTransitions("VISA")[0]?.commentHint).toBe(true);
  });

  it("associe un ton aux statuts", () => {
    expect(periodTone("OPEN")).toBe("success");
    expect(periodTone("CLOSED")).toBe("warning");
    expect(periodTone("LOCKED")).toBe("neutral");
    expect(checklistTone("DONE")).toBe("success");
    expect(checklistTone("TODO")).toBe("warning");
    expect(checklistTone("NA")).toBe("neutral");
  });

  it("calcule l'avancement d'une liste de contrôle", () => {
    const items = [
      { status: "DONE" as const, blocking: true },
      { status: "NA" as const, blocking: false },
      { status: "TODO" as const, blocking: true },
      { status: "TODO" as const, blocking: false },
    ];
    expect(checklistProgress(items)).toEqual({ done: 2, total: 4, blockingTodo: 1 });
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, blockingTodo: 0 });
  });

  it("lit la note de preuve et le code de période", () => {
    expect(evidenceNote({ note: "Relevé rapproché" })).toBe("Relevé rapproché");
    expect(evidenceNote({ note: 3 })).toBe("");
    expect(evidenceNote(null)).toBe("");
    expect(periodCode("2025-03-01")).toBe("2025-03");
  });
});
