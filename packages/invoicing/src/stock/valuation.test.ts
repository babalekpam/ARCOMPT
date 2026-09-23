// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { Money } from "@arcompt/ledger";
import { Quantity, mulDivRound } from "./quantity.js";
import { replayValuation, unitCostOf, valueCountedQuantity, valueFromUnitCost, type ValuationMovement } from "./valuation.js";

const q = (v: string) => Quantity.parse(v);
const m = (v: string) => Money.parse(v);

function entry(id: string, date: string, quantity: string, unitCost: string): ValuationMovement {
  return { id, date, kind: "IN", quantity: q(quantity), value: valueFromUnitCost(m(unitCost), q(quantity)) };
}

function exit(id: string, date: string, quantity: string): ValuationMovement {
  return { id, date, kind: "OUT", quantity: q(quantity) };
}

describe("Quantity", () => {
  it("garde quatre décimales exactes, sans flottant", () => {
    expect(q("12").toString()).toBe("12.0000");
    expect(q("0.5").toString()).toBe("0.5000");
    expect(q("1250.75").toString()).toBe("1250.7500");
    expect(q("1 250,75").toString()).toBe("1250.7500");
    expect(q("0.1").add(q("0.2")).toString()).toBe("0.3000"); // 0.1 + 0.2 en flottant vaut 0.30000000000000004
    expect(() => q("1.00001")).toThrow(/décimales/);
    expect(() => q("douze")).toThrow(/invalide/);
  });

  it("arrondit au plus proche, demi vers l'infini", () => {
    expect(mulDivRound(5n, 1n, 2n)).toBe(3n); // 2,5 → 3
    expect(mulDivRound(-5n, 1n, 2n)).toBe(-3n); // −2,5 → −3
    expect(mulDivRound(4n, 1n, 2n)).toBe(2n);
    expect(mulDivRound(1n, 1n, 3n)).toBe(0n);
  });
});

describe("Évaluation CUMP (coût unitaire moyen pondéré après chaque entrée)", () => {
  // L'exemple que tout manuel de comptabilité OHADA donne, et qui se vérifie à la main.
  const movements = [
    entry("a", "2025-01-01", "100", "10000"), // 1 000 000
    entry("b", "2025-03-15", "300", "12000"), // 3 600 000 → 400 pour 4 600 000, CUMP 11 500
    exit("c", "2025-06-30", "250"), //            250 × 11 500 = 2 875 000 → 150 pour 1 725 000
    entry("d", "2025-09-10", "250", "13000"), // 3 250 000 → 400 pour 4 975 000, CUMP 12 437,50
    exit("e", "2025-12-15", "320"), //            320 × 12 437,50 = 3 980 000 → 80 pour 995 000
  ];

  it("recalcule le coût moyen après chaque entrée et valorise les sorties", () => {
    const state = replayValuation("CUMP", movements);
    expect(state.steps.map((s) => s.value.toString())).toEqual(["1000000.0000", "3600000.0000", "2875000.0000", "3250000.0000", "3980000.0000"]);
    expect(state.steps.map((s) => s.quantityAfter.toString())).toEqual(["100.0000", "400.0000", "150.0000", "400.0000", "80.0000"]);
    expect(state.quantity.toString()).toBe("80.0000");
    expect(state.value.toString()).toBe("995000.0000");
    expect(unitCostOf(state)!.toString()).toBe("12437.5000");
  });

  it("laisse la valeur résiduelle exacte : l'écart d'arrondi tombe dans la consommation", () => {
    // 1 000 pour 10 000 ; on sort 1 : le reliquat vaut exactement 10 000 × 999/1000.
    const state = replayValuation("CUMP", [entry("a", "2025-01-01", "1000", "10"), exit("b", "2025-02-01", "1")]);
    expect(state.quantity.toString()).toBe("999.0000");
    expect(state.value.toString()).toBe("9990.0000");
    expect(state.steps[1]!.value.toString()).toBe("10.0000");
  });

  it("solde exactement l'article quand la sortie emporte tout le stock", () => {
    // 3 unités pour 10 : aucun coût unitaire entier n'existe ; la sortie totale
    // doit néanmoins ramener la valeur à zéro, sans centime résiduel.
    const state = replayValuation("CUMP", [entry("a", "2025-01-01", "3", "3.3333"), exit("b", "2025-02-01", "3")]);
    expect(state.quantity.isZero()).toBe(true);
    expect(state.value.toString()).toBe("0.0000");
    expect(unitCostOf(state)).toBeNull();
  });

  it("refuse une sortie supérieure au stock disponible", () => {
    expect(() => replayValuation("CUMP", [entry("a", "2025-01-01", "10", "100"), exit("b", "2025-02-01", "11")])).toThrow(/sortie de 11/);
  });

  it("refuse une entrée sans valeur", () => {
    expect(() => replayValuation("CUMP", [{ id: "a", date: "2025-01-01", kind: "IN", quantity: q("1") }])).toThrow(/doit porter sa valeur/);
  });

  it("valorise une quantité comptée au coût moyen du moment", () => {
    const state = replayValuation("CUMP", movements);
    expect(valueCountedQuantity(state, q("78")).toString()).toBe("970125.0000"); // 78 × 12 437,50
    expect(valueCountedQuantity(state, q("80")).toString()).toBe("995000.0000"); // comptage conforme
    expect(valueCountedQuantity(state, q("82")).toString()).toBe("1019875.0000"); // excédent au même coût
  });
});

describe("Évaluation PEPS (premier entré, premier sorti)", () => {
  const movements = [
    entry("a", "2025-01-01", "100", "10000"), // couche 1
    entry("b", "2025-03-15", "300", "12000"), // couche 2
    exit("c", "2025-06-30", "250"), //  100 × 10 000 + 150 × 12 000 = 2 800 000
    entry("d", "2025-09-10", "250", "13000"), // couche 3
    exit("e", "2025-12-15", "320"), //  150 × 12 000 + 170 × 13 000 = 4 010 000
  ];

  it("consomme les couches les plus anciennes d'abord", () => {
    const state = replayValuation("FIFO", movements);
    expect(state.steps[2]!.value.toString()).toBe("2800000.0000");
    expect(state.steps[4]!.value.toString()).toBe("4010000.0000");
    // Reste 80 unités de la couche à 13 000.
    expect(state.quantity.toString()).toBe("80.0000");
    expect(state.value.toString()).toBe("1040000.0000");
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]!.movementId).toBe("d");
  });

  it("valorise l'inventaire physique aux entrées les plus récentes", () => {
    const state = replayValuation("FIFO", movements);
    expect(valueCountedQuantity(state, q("78")).toString()).toBe("1014000.0000"); // 78 × 13 000
    // 100 comptés pour 80 en stock : les 20 excédentaires prennent le dernier coût connu.
    expect(valueCountedQuantity(state, q("100")).toString()).toBe("1300000.0000");
  });

  it("donne un stock final plus élevé que le CUMP quand les prix montent (effet attendu du PEPS)", () => {
    const fifo = replayValuation("FIFO", movements);
    const cump = replayValuation("CUMP", movements);
    expect(fifo.quantity.eq(cump.quantity)).toBe(true);
    expect(fifo.value.cmp(cump.value)).toBe(1); // 1 040 000 > 995 000
    // …et donc une consommation plus faible, à achats identiques.
    const consumedFifo = fifo.steps.filter((s) => s.kind === "OUT").reduce((a, s) => a.add(s.value), Money.zero());
    const consumedCump = cump.steps.filter((s) => s.kind === "OUT").reduce((a, s) => a.add(s.value), Money.zero());
    expect(consumedFifo.cmp(consumedCump)).toBe(-1);
    // Invariant commun aux deux méthodes : entrées = sorties + stock résiduel.
    const inFlow = m("1000000").add(m("3600000")).add(m("3250000"));
    expect(consumedFifo.add(fifo.value).toString()).toBe(inFlow.toString());
    expect(consumedCump.add(cump.value).toString()).toBe(inFlow.toString());
  });

  it("répartit exactement une couche partiellement consommée", () => {
    const state = replayValuation("FIFO", [entry("a", "2025-01-01", "3", "10"), exit("b", "2025-02-01", "1"), exit("c", "2025-03-01", "2")]);
    expect(state.steps[1]!.value.toString()).toBe("10.0000");
    expect(state.steps[2]!.value.toString()).toBe("20.0000");
    expect(state.value.toString()).toBe("0.0000");
  });
});

describe("valueFromUnitCost", () => {
  it("multiplie sans passer par un flottant", () => {
    expect(valueFromUnitCost(m("12437.5"), q("78")).toString()).toBe("970125.0000");
    expect(valueFromUnitCost(m("0.0001"), q("0.5")).toString()).toBe("0.0001"); // 0,00005 → 0,0001
  });
});
