// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { detectSeparator, mapHeaders, parseAmount, parseDate, parseStatementCsv } from "./csv.js";

describe("parseAmount", () => {
  it("lit les formats français, anglais, avec devise et parenthèses", () => {
    expect(parseAmount("1 234,56")!.toString()).toBe("1234.5600");
    expect(parseAmount("1.234,56")!.toString()).toBe("1234.5600");
    expect(parseAmount("1,234.56")!.toString()).toBe("1234.5600");
    expect(parseAmount("25,000")!.toString()).toBe("25000.0000");
    expect(parseAmount("25 000 FCFA")!.toString()).toBe("25000.0000");
    expect(parseAmount("12,5")!.toString()).toBe("12.5000");
    expect(parseAmount("(500)")!.toString()).toBe("-500.0000");
    expect(parseAmount("500-")!.toString()).toBe("-500.0000");
    expect(parseAmount("-1 180 000")!.toString()).toBe("-1180000.0000");
    expect(parseAmount("1 000 000")!.toString()).toBe("1000000.0000");
    expect(parseAmount("1'500.25")!.toString()).toBe("1500.2500");
  });

  it("respecte un séparateur décimal imposé et refuse l'illisible", () => {
    expect(parseAmount("1.500", ".")!.toString()).toBe("1.5000");
    expect(parseAmount("1,500", ",")!.toString()).toBe("1.5000");
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("1.2.3,4")!.toString()).toBe("123.4000");
  });
});

describe("parseDate", () => {
  it("accepte JJ/MM/AAAA, JJ-MM-AA, AAAA-MM-JJ, AAAAMMJJ et l'heure en suffixe", () => {
    expect(parseDate("15/09/2025")).toBe("2025-09-15");
    expect(parseDate("15-09-25")).toBe("2025-09-15");
    expect(parseDate("15.09.2025")).toBe("2025-09-15");
    expect(parseDate("2025-09-15")).toBe("2025-09-15");
    expect(parseDate("2025/09/15 10:00")).toBe("2025-09-15");
    expect(parseDate("20250915")).toBe("2025-09-15");
    expect(parseDate("2025-09-15T08:30:00Z")).toBe("2025-09-15");
  });
  it("gère MDY explicite ou détecté, et refuse les dates impossibles", () => {
    expect(parseDate("09/15/2025", "MDY")).toBe("2025-09-15");
    expect(parseDate("09/15/2025")).toBe("2025-09-15"); // mois > 12 impossible → inversion
    expect(parseDate("31/02/2025")).toBeNull();
    expect(parseDate("n/a")).toBeNull();
  });
});

describe("détection de structure", () => {
  it("détecte le séparateur hors guillemets", () => {
    expect(detectSeparator("Date;Libellé;Montant")).toBe(";");
    expect(detectSeparator('Date,"Libellé, long",Montant')).toBe(",");
    expect(detectSeparator("Date\tLibellé\tMontant")).toBe("\t");
  });
  it("reconnaît les en-têtes par synonymes, accents et casse ignorés", () => {
    const cols = mapHeaders(["Date opération", "Date de valeur", "Libellé de l'opération", "Débit (XOF)", "Crédit (XOF)", "N° de pièce", "ID transaction"]);
    expect(cols).toEqual({ date: 0, valueDate: 1, label: 2, debit: 3, credit: 4, reference: 5, externalId: 6 });
  });
});

describe("parseStatementCsv", () => {
  it("lit un relevé ; débit/crédit, décimales à virgule, dates françaises", () => {
    const csv = [
      "Date;Libellé;Débit;Crédit;Référence",
      "05/03/2025;VIR CLIENT ALPHA FAC-2025-001;;1 180 000,00;VIR001",
      "06/03/2025;FRAIS TENUE DE COMPTE;5 000,00;;",
      "",
      '12/03/2025;"REMISE CHEQUE; 2 EFFETS";;250 000,00;CHQ12345',
    ].join("\n");
    const { rows, errors, detected } = parseStatementCsv(csv);
    expect(errors).toEqual([]);
    expect(detected.layout).toBe("DEBIT_CREDIT");
    expect(detected.separator).toBe(";");
    expect(rows).toEqual([
      { date: "2025-03-05", label: "VIR CLIENT ALPHA FAC-2025-001", amount: "1180000.0000", reference: "VIR001" },
      { date: "2025-03-06", label: "FRAIS TENUE DE COMPTE", amount: "-5000.0000" },
      { date: "2025-03-12", label: "REMISE CHEQUE; 2 EFFETS", amount: "250000.0000", reference: "CHQ12345" },
    ]);
  });

  it("lit un montant signé, séparateur virgule, dates ISO, BOM et préambule de banque", () => {
    const csv = "﻿Relevé du compte 0001234\nPériode : mars 2025\n\nDate,Description,Amount,Value date\n2025-03-05,Transfer from ALPHA,\"1,180,000\",2025-03-06\n2025-03-06,Bank charges,-5000,2025-03-06\n";
    const { rows, errors, detected } = parseStatementCsv(csv);
    expect(errors).toEqual([]);
    expect(detected.layout).toBe("SIGNED");
    expect(detected.headerLine).toBe(4);
    expect(rows).toEqual([
      { date: "2025-03-05", label: "Transfer from ALPHA", amount: "1180000.0000", valueDate: "2025-03-06" },
      { date: "2025-03-06", label: "Bank charges", amount: "-5000.0000", valueDate: "2025-03-06" },
    ]);
  });

  it("applique une colonne sens (D/C) quand elle est cohérente, sinon garde le signe", () => {
    const withSens = "Date;Libelle;Montant;Sens\n05/03/2025;Encaissement;1000;C\n06/03/2025;Frais;500;D";
    expect(parseStatementCsv(withSens).rows.map((r) => r.amount)).toEqual(["1000.0000", "-500.0000"]);
    const withType = "Date;Libelle;Montant;Type\n05/03/2025;Encaissement;1000;VIREMENT\n06/03/2025;Frais;-500;FRAIS";
    const parsed = parseStatementCsv(withType);
    expect(parsed.detected.layout).toBe("SIGNED");
    expect(parsed.rows.map((r) => r.amount)).toEqual(["1000.0000", "-500.0000"]);
  });

  it("rapporte les lignes illisibles sans les deviner, et refuse un fichier sans en-tête", () => {
    const csv = "Date;Libelle;Montant\n05/03/2025;OK;100\nhier;Mauvaise date;100\n07/03/2025;Montant nul;0\n08/03/2025;Montant texte;abc";
    const { rows, errors } = parseStatementCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5]);
    const none = parseStatementCsv("a;b;c\n1;2;3");
    expect(none.rows).toEqual([]);
    expect(none.errors[0]!.message).toMatch(/En-tête introuvable/);
  });

  it("accepte une correspondance explicite de colonnes, avec ou sans en-tête", () => {
    const headless = "05/03/2025;1000;Vente\n06/03/2025;-200;Frais";
    const parsed = parseStatementCsv(headless, { hasHeader: false, columns: { date: 0, amount: 1, label: 2 } });
    expect(parsed.rows.map((r) => [r.date, r.amount, r.label])).toEqual([
      ["2025-03-05", "1000.0000", "Vente"],
      ["2025-03-06", "-200.0000", "Frais"],
    ]);
    const named = "Quand;Combien;Quoi\n05/03/2025;1000;Vente";
    expect(parseStatementCsv(named, { columns: { date: "Quand", amount: "Combien", label: "quoi" } }).rows).toHaveLength(1);
  });

  it("inverse débit/crédit si le fichier est du point de vue de la banque", () => {
    const csv = "Date;Libelle;Debit;Credit\n05/03/2025;Client;1000;\n06/03/2025;Frais;;50";
    expect(parseStatementCsv(csv, { bankPerspective: true }).rows.map((r) => r.amount)).toEqual(["1000.0000", "-50.0000"]);
  });
});
