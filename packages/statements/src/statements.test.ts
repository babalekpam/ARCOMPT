import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { balanceFromRows, computeStatements, evalFormula, indexBalance, parseTerm } from "./index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "balances");

interface Fixture {
  fiscalYear: string;
  currency: string;
  system: "NORMAL" | "SMT";
  rows: Array<{ account: string; label: string; debit: string; credit: string }>;
}

function load(name: string, file: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, name, file), "utf8")) as Fixture;
}

const b2024 = load("demo-ci", "balance-2024.json");
const b2025 = load("demo-ci", "balance-2025.json");
const expected = JSON.parse(readFileSync(join(FIXTURES, "demo-ci", "expected.json"), "utf8")) as Record<string, Record<string, string>>;

const output = computeStatements({
  system: "NORMAL",
  currency: "XOF",
  fiscalYearCode: "2025",
  balance: balanceFromRows(b2025.rows),
  previousBalance: balanceFromRows(b2024.rows),
});

describe("formules", () => {
  it("analyse les termes", () => {
    expect(parseTerm("+411:D")).toEqual({ sign: 1, root: "411", side: "D", prev: false });
    expect(parseTerm("-prev:16")).toEqual({ sign: -1, root: "16", side: null, prev: true });
    expect(parseTerm("-21:CM")).toEqual({ sign: -1, root: "21", side: "CM", prev: false });
    expect(() => parseTerm("411D")).toThrow();
  });

  it("ne retient que le sens demandé, par compte de dernier niveau", () => {
    const idx = indexBalance(balanceFromRows([
      { account: "4111", debit: "100", credit: "0" },
      { account: "4112", debit: "0", credit: "30" },
      { account: "491", debit: "0", credit: "10" },
    ]));
    expect(evalFormula(["+411:D"], idx, new Map()).amount.toString()).toBe("100.0000");
    expect(evalFormula(["+411:C"], idx, new Map()).amount.toString()).toBe("30.0000");
    expect(evalFormula(["+411"], idx, new Map()).amount.toString()).toBe("70.0000");
    expect(evalFormula(["+491:C"], idx, new Map()).accounts).toEqual(["491"]);
  });
});

describe("balance de référence demo-ci (SYSCOHADA révisé 2017.1)", () => {
  it("passe tous les contrôles bloquants", () => {
    const failed = output.controls.filter((c) => c.severity === "BLOCKING" && !c.ok);
    expect(failed).toEqual([]);
    expect(output.publishable).toBe(true);
    expect(output.orphanAccounts).toEqual([]);
  });

  for (const [statement, lines] of Object.entries(expected)) {
    it(`reproduit les postes attendus : ${statement}`, () => {
      const st = output.statements[statement as keyof typeof output.statements];
      expect(st).toBeDefined();
      for (const [code, value] of Object.entries(lines)) {
        const [net, prev] = value.split("|");
        expect(`${code}=${st!.byCode[code]?.net.toString()}`).toBe(`${code}=${net}`);
        if (prev !== undefined) expect(`${code} N-1=${st!.byCode[code]?.previousNet.toString()}`).toBe(`${code} N-1=${prev}`);
      }
    });
  }

  it("rapproche chaque note chiffrée de son poste", () => {
    const ledgerNotes = output.notes.filter((n) => n.kind === "LEDGER");
    expect(ledgerNotes.length).toBeGreaterThanOrEqual(10);
    for (const n of ledgerNotes) expect(`${n.number}:${n.reconciles?.ok}`).toBe(`${n.number}:true`);
    const note7 = output.notes.find((n) => n.number === 7)!;
    expect(note7.total.toString()).toBe("1180000.0000");
    expect(note7.rows[0]).toMatchObject({ label: "Clients" });
  });

  it("marque les notes narratives et modules comme brouillons à valider", () => {
    const narrative = output.notes.filter((n) => n.kind !== "LEDGER");
    expect(narrative.map((n) => n.status)).toEqual(narrative.map(() => "DRAFT_REQUIRED"));
    expect(narrative.find((n) => n.number === 2)?.outline?.length).toBeGreaterThan(2);
  });

  it("est déterministe : même balance, même gabarit, mêmes états", () => {
    const again = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows(b2025.rows), previousBalance: balanceFromRows(b2024.rows) });
    expect(JSON.stringify(again)).toBe(JSON.stringify(output));
  });

  it("bloque sur un solde orphelin et sur un déséquilibre", () => {
    const rows = [...b2025.rows, { account: "699", label: "Compte hors gabarit", debit: "1000", credit: "0" }, { account: "521", label: "", debit: "0", credit: "1000" }];
    const out = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows(rows) });
    expect(out.orphanAccounts).toEqual(["699"]);
    expect(out.publishable).toBe(false);
    expect(out.controls.find((c) => c.id === "AUCUN_SOLDE_ORPHELIN")?.ok).toBe(false);

    const unbalanced = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows([{ account: "521", debit: "10", credit: "0" }]) });
    expect(unbalanced.controls.find((c) => c.id === "BALANCE_EQUILIBREE")?.ok).toBe(false);
    expect(unbalanced.controls.find((c) => c.id === "ACTIF_EGAL_PASSIF")?.ok).toBe(false);
  });

  it("signale les alertes non bloquantes sans empêcher la publication", () => {
    const rows = [...b2025.rows, { account: "571", label: "Caisse", debit: "0", credit: "5000" }, { account: "471", label: "Attente", debit: "5000", credit: "0" }];
    const out = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows(rows) });
    expect(out.controls.find((c) => c.id === "CAISSE_CREDITRICE")?.ok).toBe(false);
    expect(out.controls.find((c) => c.id === "COMPTE_ATTENTE_SOLDE")?.ok).toBe(false);
    expect(out.controls.filter((c) => c.severity === "BLOCKING" && !c.ok)).toEqual([]);
  });

  it("système minimal de trésorerie : pas de TFT, notes réduites", () => {
    const out = computeStatements({ system: "SMT", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows(b2025.rows), previousBalance: balanceFromRows(b2024.rows) });
    expect(out.statements.TFT).toBeUndefined();
    expect(out.notes.length).toBeLessThan(output.notes.length);
    expect(out.publishable).toBe(true);
  });
});

describe("devise des états", () => {
  const rows = [
    { account: "521", label: "Banque", debit: "1000", credit: "0" },
    { account: "101", label: "Capital", debit: "0", credit: "1000" },
  ];

  it("refuse une devise de présentation qui n'est pas un code ISO 4217", () => {
    expect(() => computeStatements({ system: "NORMAL", currency: "franc", fiscalYearCode: "2025", balance: balanceFromRows(rows) })).toThrow(/ISO 4217/);
  });

  it("normalise la devise et la reprend dans la sortie", () => {
    const out = computeStatements({ system: "NORMAL", currency: "xaf", fiscalYearCode: "2025", balance: balanceFromRows(rows) });
    expect(out.currency).toBe("XAF");
  });

  it("bloque la publication d'états présentés dans une devise autre que celle de la balance", () => {
    const desaccord = computeStatements({
      system: "NORMAL",
      currency: "XOF",
      balanceCurrency: "XAF",
      fiscalYearCode: "2025",
      balance: balanceFromRows(rows),
    });
    const ctrl = desaccord.controls.find((c) => c.id === "DEVISE_ETATS")!;
    expect(ctrl).toMatchObject({ ok: false, severity: "BLOCKING", expected: "XOF", actual: "XAF" });
    expect(desaccord.publishable).toBe(false);

    const accord = computeStatements({ system: "NORMAL", currency: "XAF", balanceCurrency: "XAF", fiscalYearCode: "2025", balance: balanceFromRows(rows) });
    expect(accord.controls.find((c) => c.id === "DEVISE_ETATS")?.ok).toBe(true);
  });

  it("n'émet le contrôle de devise que si la balance annonce la sienne", () => {
    const out = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows(rows) });
    expect(out.controls.find((c) => c.id === "DEVISE_ETATS")).toBeUndefined();
  });

  it("signale les résidus de conversion sous l'unité monétaire, sans bloquer", () => {
    const avecCentimes = [
      { account: "521", label: "Banque", debit: "1000.4567", credit: "0" },
      { account: "101", label: "Capital", debit: "0", credit: "1000.4567" },
    ];
    const xof = computeStatements({ system: "NORMAL", currency: "XOF", fiscalYearCode: "2025", balance: balanceFromRows(avecCentimes) });
    const ctrl = xof.controls.find((c) => c.id === "UNITE_MONETAIRE")!;
    expect(ctrl).toMatchObject({ ok: false, severity: "WARNING" });
    expect(ctrl.detail).toContain("521");
    // Le franc CFA n'a pas de sous-unité ; l'euro en a deux.
    const eur = computeStatements({ system: "NORMAL", currency: "EUR", fiscalYearCode: "2025", balance: balanceFromRows([
      { account: "521", label: "Banque", debit: "1000.45", credit: "0" },
      { account: "101", label: "Capital", debit: "0", credit: "1000.45" },
    ]) });
    expect(eur.controls.find((c) => c.id === "UNITE_MONETAIRE")?.ok).toBe(true);
  });

  it("le jeu de référence demo-ci reste publiable et sans résidu de conversion", () => {
    expect(output.controls.find((c) => c.id === "UNITE_MONETAIRE")?.ok).toBe(true);
    expect(output.publishable).toBe(true);
  });
});
