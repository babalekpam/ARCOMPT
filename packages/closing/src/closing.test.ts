import { describe, expect, it } from "vitest";
import { ANNUAL_CHECKLIST, checklistAllowsClose, checklistProgress, MONTHLY_CHECKLIST, openBlockingItems } from "./checklist.js";
import { checkTransition, nextStates, WORKFLOW_EDGES } from "./workflow.js";

describe("listes de contrôle", () => {
  it("définit les gabarits mensuel et annuel attendus", () => {
    expect(MONTHLY_CHECKLIST.map((i) => i.key)).toEqual(["bank_reconciled", "lettrage_401_411", "vat_declared", "cash_counted", "suspense_471_cleared", "missing_documents"]);
    expect(ANNUAL_CHECKLIST.map((i) => i.key)).toEqual(["depreciation", "provisions", "accruals_476_477", "inventory", "income_tax", "equity_auscgie"]);
  });

  it("bloque tant qu'un item bloquant est TODO, accepte NA et les items non bloquants ouverts", () => {
    const items = MONTHLY_CHECKLIST.map((i) => ({ ...i, status: "TODO" as const }));
    expect(checklistAllowsClose(items).ok).toBe(false);
    expect(openBlockingItems(items).map((i) => i.key)).toEqual(["bank_reconciled", "vat_declared", "cash_counted", "suspense_471_cleared"]);
    const ticked = items.map((i) => ({ ...i, status: i.blocking ? (i.key === "vat_declared" ? ("NA" as const) : ("DONE" as const)) : ("TODO" as const) }));
    expect(checklistAllowsClose(ticked)).toEqual({ ok: true, blocking: [] });
    expect(checklistProgress(ticked)).toBe(67);
  });
});

describe("workflow de l'exercice", () => {
  const accountant = { userId: "u-acc", roles: ["ACCOUNTANT"] };
  const reviewer = { userId: "u-rev", roles: ["REVIEWER"] };

  it("expose les arêtes de la section 10 de l'architecture", () => {
    expect(WORKFLOW_EDGES.map((e) => `${e.from}>${e.to}`)).toEqual(["TENUE>REVISION", "REVISION>TENUE", "REVISION>ETATS", "ETATS>VISA", "VISA>REVISION", "VISA>DEPOT", "DEPOT>VERROUILLE"]);
    expect(nextStates("VISA")).toEqual(["REVISION", "DEPOT"]);
    expect(nextStates("VERROUILLE")).toEqual([]);
  });

  it("refuse une transition hors graphe", () => {
    expect(checkTransition("TENUE", "ETATS", { actor: accountant })).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });

  it("exige les contrôles pour produire les états", () => {
    expect(checkTransition("REVISION", "ETATS", { actor: accountant })).toMatchObject({ ok: false, code: "CONTROLS_FAILED" });
    expect(checkTransition("REVISION", "ETATS", { actor: accountant, controlsOk: true }).ok).toBe(true);
  });

  it("réserve le visa aux REVIEWER/OWNER, différents de celui qui a produit les états", () => {
    expect(checkTransition("VISA", "DEPOT", { actor: accountant })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(checkTransition("VISA", "DEPOT", { actor: reviewer, statementsPreparedBy: "u-rev" })).toMatchObject({ ok: false, code: "SEPARATION_OF_DUTIES" });
    expect(checkTransition("VISA", "DEPOT", { actor: reviewer, statementsPreparedBy: "u-acc" }).ok).toBe(true);
    expect(checkTransition("VISA", "REVISION", { actor: accountant })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(checkTransition("VISA", "REVISION", { actor: reviewer }).ok).toBe(true);
  });

  it("exige l'accusé de dépôt pour verrouiller", () => {
    expect(checkTransition("DEPOT", "VERROUILLE", { actor: accountant })).toMatchObject({ ok: false, code: "RECEIPT_REQUIRED" });
    expect(checkTransition("DEPOT", "VERROUILLE", { actor: accountant, filingReceiptDocumentId: "doc-1" }).ok).toBe(true);
  });

  it("refuse les rôles sans droit d'écriture", () => {
    expect(checkTransition("TENUE", "REVISION", { actor: { userId: "u", roles: ["AUDITOR"] } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});
