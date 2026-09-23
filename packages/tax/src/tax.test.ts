// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import { describe, expect, it } from "vitest";
import { Money } from "@arcompt/ledger";
import { loadPack } from "@arcompt/country-packs";
import { computeStatements, balanceFromRows } from "@arcompt/statements";
import { computeVatReturn } from "./vat.js";
import { computeIsInstalments, splitEqual } from "./is.js";
import { filingCalendar } from "./calendar.js";
import { buildDsfData, dsfWorkbook, DSF_SHEETS } from "./dsf.js";

const pack = loadPack("ci");
const M = (s: string) => Money.parse(s);

describe("computeVatReturn", () => {
  const lines = [
    { accountNumber: "443", vatCode: "TVA18", debit: M("0"), credit: M("180000") },
    { accountNumber: "443", vatCode: "TVA9", debit: M("0"), credit: M("9000") },
    { accountNumber: "445", vatCode: "TVA18", debit: M("72000"), credit: M("0") },
    { accountNumber: "445", vatCode: null, debit: M("1000"), credit: M("0") },
  ];

  it("calcule collectée, déductible, net et TVA due par code, avec les bases reconstituées", () => {
    const r = computeVatReturn({ periodFrom: "2025-03-01", periodTo: "2025-03-31", lines, pack });
    expect(r.totalCollected.toString()).toBe("189000.0000");
    expect(r.totalDeductible.toString()).toBe("73000.0000");
    expect(r.net.toString()).toBe("116000.0000");
    expect(r.amountDue.toString()).toBe("116000.0000");
    expect(r.creditCarried.isZero()).toBe(true);
    expect(r.collected.map((c) => [c.vatCode, c.rate, c.base?.toString()])).toEqual([
      ["TVA18", "0.18", "1000000.0000"],
      ["TVA9", "0.09", "100000.0000"],
    ]);
    expect(r.deductible.find((d) => d.vatCode === "SANS_CODE")!.base).toBeNull();
  });

  it("impute le crédit antérieur et reporte l'excédent", () => {
    const r = computeVatReturn({ periodFrom: "2025-03-01", periodTo: "2025-03-31", lines, previousCredit: "200000" });
    expect(r.amountDue.isZero()).toBe(true);
    expect(r.creditCarried.toString()).toBe("84000.0000");
  });

  it("renvoie un crédit quand la déductible dépasse la collectée", () => {
    const r = computeVatReturn({ periodFrom: "2025-03-01", periodTo: "2025-03-31", lines: [{ accountNumber: "445", vatCode: "TVA18", debit: M("5000"), credit: M("0") }] });
    expect(r.net.toString()).toBe("-5000.0000");
    expect(r.creditCarried.toString()).toBe("5000.0000");
  });
});

describe("computeIsInstalments", () => {
  it("applique is.amount, imf.amount et is.due puis répartit en acomptes", () => {
    const r = computeIsInstalments({ pack, date: "2025-12-31", fiscalResult: "10000000", turnover: "60000000" });
    expect(r.isAmount.toString()).toBe("2500000.0000");
    expect(r.imfAmount.toString()).toBe("300000.0000");
    expect(r.due.toString()).toBe("2500000.0000");
    expect(r.instalments.map((i) => i.amount.toString())).toEqual(["625000.0000", "625000.0000", "625000.0000", "625000.0000"]);
    expect(r.instalments.map((i) => i.dueDate)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });

  it("retient l'IMF quand il dépasse l'IS (résultat déficitaire)", () => {
    const r = computeIsInstalments({ pack, date: "2025-12-31", fiscalResult: "-500000", turnover: "100000000", instalments: 3 });
    expect(r.isAmount.isZero()).toBe(true);
    expect(r.due.toString()).toBe("500000.0000");
    expect(r.instalments.map((i) => i.amount.toString())).toEqual(["166667.0000", "166667.0000", "166666.0000"]);
  });

  it("splitEqual : la dernière part absorbe l'arrondi", () => {
    expect(splitEqual(M("100"), 3).map(String)).toEqual(["33.0000", "33.0000", "34.0000"]);
  });
});

describe("filingCalendar", () => {
  it("développe le calendrier du pack en échéances datées avec statut", () => {
    const cal = filingCalendar(pack, 2025, { today: "2025-04-10", filed: [{ kind: "VAT", periodFrom: "2025-02-01", periodTo: "2025-02-28" }] });
    const vat = cal.filter((d) => d.calendarId === "vat");
    expect(vat).toHaveLength(12);
    expect(vat[0]).toMatchObject({ periodLabel: "2024-12", dueDate: "2025-01-15", status: "OVERDUE", kind: "VAT" });
    expect(vat.find((d) => d.periodLabel === "2025-02")!.status).toBe("DONE");
    expect(vat.find((d) => d.periodLabel === "2025-03")!).toMatchObject({ dueDate: "2025-04-15", status: "DUE_SOON" });
    expect(vat.find((d) => d.periodLabel === "2025-04")!.status).toBe("UPCOMING");
    expect(cal.filter((d) => d.calendarId === "is_acompte").map((d) => d.dueDate)).toEqual(["2025-01-15", "2025-04-15", "2025-07-15", "2025-10-15"]);
    expect(cal.find((d) => d.calendarId === "dsf")).toMatchObject({ dueDate: "2025-06-30", periodLabel: "2024", kind: "DSF" });
  });
});

describe("DSF", () => {
  const statements = computeStatements({
    system: "NORMAL",
    currency: "XOF",
    fiscalYearCode: "2025",
    balance: balanceFromRows([
      { account: "101", debit: "0", credit: "5000000" },
      { account: "521", debit: "6180000", credit: "0" },
      { account: "706", debit: "0", credit: "1000000" },
      { account: "443", debit: "0", credit: "180000" },
    ]),
  });

  it("calcule le passage fiscal avec les règles du pack", () => {
    const dsf = buildDsfData({ pack, statements, date: "2025-12-31", adjustments: { reintegrations: "200000", deductions: "50000" } });
    expect(dsf.fiscal.accountingResult.toString()).toBe("1000000.0000");
    expect(dsf.fiscal.fiscalResult.toString()).toBe("1150000.0000");
    expect(dsf.fiscal.turnover.toString()).toBe("1000000.0000");
    expect(dsf.fiscal.isAmount.toString()).toBe("287500.0000");
    expect(dsf.fiscal.imfAmount.toString()).toBe("5000.0000");
    expect(dsf.fiscal.isDue.toString()).toBe("287500.0000");
    expect(dsf.fiscal.rules.map((r) => r.id)).toEqual(["dsf.resultat_fiscal", "is.amount", "imf.amount", "is.due"]);
  });

  it("exporte un classeur Excel avec les onglets attendus", async () => {
    const dsf = buildDsfData({ pack, statements, date: "2025-12-31", adjustments: { reintegrations: "0", deductions: "0" } });
    const buffer = await dsfWorkbook(dsf, { company: { name: "SARL Test", taxIds: { NCC: "1234567A" } } });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual([...DSF_SHEETS]);
    const passif = wb.getWorksheet("Bilan passif")!;
    const cjRow = passif.getRows(1, passif.rowCount)!.find((r) => r.getCell(1).value === "CJ");
    expect(cjRow?.getCell(4).value).toBe(1000000);
  });
});
