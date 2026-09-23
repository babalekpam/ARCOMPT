// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
import ExcelJS from "exceljs";
import { Money } from "@arcompt/ledger";
import { draftPackNotice, isPackPublished, packRules, type CountryPack, type OfficialUse } from "@arcompt/country-packs";
import type { Decimal } from "@arcompt/rules";
import type { ComputedStatement, StatementsOutput } from "@arcompt/statements";
import { TaxError, type DsfAdjustments, type DsfFiscal, type DsfResult } from "./types.js";
import { decimalToMoney, moneyToDecimal } from "./vat.js";

export interface DsfInput {
  pack: CountryPack;
  statements: StatementsOutput;
  /** Date d'évaluation des règles (fin d'exercice). */
  date: string;
  adjustments: DsfAdjustments;
  /**
   * Résultat de la garde `assertPackPublished` posée par l'appelant. Absent,
   * la liasse est réputée non officielle dès que le pack ne l'est pas : cette
   * fonction est pure, elle ne lit pas l'environnement et ne lève rien — c'est
   * au service d'opposer le refus.
   */
  official?: OfficialUse;
}

/**
 * Passage du résultat comptable au résultat fiscal (règle `dsf.resultat_fiscal`
 * du pack, sinon comptable + réintégrations − déductions) puis impôt dû.
 * Fonction pure sur des états déjà calculés.
 */
export function buildDsfData(input: DsfInput): DsfResult {
  const cr = input.statements.statements.COMPTE_RESULTAT;
  if (!cr) throw new TaxError("INVALID_INPUT", "Compte de résultat absent des états");
  const accountingResult = cr.byCode.XI?.net ?? Money.zero();
  const turnover = cr.byCode.XB?.net ?? Money.zero();
  const reintegrations = Money.parse(input.adjustments.reintegrations);
  const deductions = Money.parse(input.adjustments.deductions);
  const rules = packRules(input.pack);
  const ids = new Set(rules.ids());
  const used: DsfFiscal["rules"] = [];
  const scope: Record<string, Decimal> = {
    resultat_comptable: moneyToDecimal(accountingResult),
    reintegrations: moneyToDecimal(reintegrations),
    deductions: moneyToDecimal(deductions),
    ca_annuel: moneyToDecimal(turnover),
  };
  const evalMoney = (id: string): Money => {
    const r = rules.evaluate(id, input.date, scope);
    used.push({ id, source: r.version.source ?? null, validFrom: r.version.valid_from });
    return decimalToMoney(r.value as Decimal);
  };
  const fiscalResult = ids.has("dsf.resultat_fiscal") ? evalMoney("dsf.resultat_fiscal") : accountingResult.add(reintegrations).sub(deductions);
  scope.resultat_fiscal = moneyToDecimal(fiscalResult);
  const isAmount = ids.has("is.amount") ? evalMoney("is.amount") : Money.zero();
  const imfAmount = ids.has("imf.amount") ? evalMoney("imf.amount") : Money.zero();
  const isDue = ids.has("is.due") ? evalMoney("is.due") : isAmount.cmp(imfAmount) >= 0 ? isAmount : imfAmount;
  return {
    fiscalYearCode: input.statements.fiscalYearCode,
    packCode: input.pack.code,
    packVersion: input.pack.version,
    label: input.pack.dsf.label,
    statements: input.statements,
    fiscal: { accountingResult, reintegrations, deductions, fiscalResult, turnover, isAmount, imfAmount, isDue, rules: used },
    official: input.official?.official ?? isPackPublished(input.pack),
    notice: input.official ? input.official.notice : draftPackNotice(input.pack),
  };
}

export const DSF_SHEETS = ["Bilan actif", "Bilan passif", "Compte de résultat", "TFT", "Notes", "Passage fiscal"] as const;

/** Classeur Excel de la DSF (un onglet par état). Les montants sont écrits en nombres à l'échelle de la devise. */
export async function dsfWorkbook(dsf: DsfResult, opts: { company?: { name: string; taxIds?: Record<string, string> } } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ARCOMPT";
  wb.created = new Date();
  const currency = dsf.statements.currency;
  const num = (m: Money | undefined): number | null => (m === undefined ? null : Number(m.format(currency).replace(/\s/g, "")));
  const header = (ws: ExcelJS.Worksheet, title: string) => {
    // La mention de non-officialité est la première ligne de chaque onglet :
    // le classeur est déposé tel quel sur un portail, on ne compte pas sur le
    // nom du fichier ni sur l'écran qui l'a produit.
    if (!dsf.official && dsf.notice) {
      const mark = ws.addRow([dsf.notice]);
      mark.font = { bold: true, size: 12, color: { argb: "FFB00020" } };
      ws.addRow([]);
    }
    ws.addRow([title]).font = { bold: true, size: 14 };
    ws.addRow([opts.company?.name ?? "", `Exercice ${dsf.fiscalYearCode}`, `Pack ${dsf.packCode} ${dsf.packVersion}`, `Devise ${currency}`]);
    if (opts.company?.taxIds) for (const [k, v] of Object.entries(opts.company.taxIds)) ws.addRow([k, v]);
    ws.addRow([]);
  };
  const statementSheet = (name: string, st: ComputedStatement | undefined, withBrut: boolean) => {
    const ws = wb.addWorksheet(name);
    header(ws, st?.title ?? name);
    const cols = withBrut ? ["Réf.", "Poste", "Note", "Brut", "Amort./dépréc.", "Net N", "Net N-1"] : ["Réf.", "Poste", "Note", "N", "N-1"];
    ws.addRow(cols).font = { bold: true };
    for (const l of st?.lines ?? []) {
      const row = withBrut
        ? ws.addRow([l.code, l.label, l.note ?? "", num(l.brut), num(l.amortProv), num(l.net), num(l.previousNet)])
        : ws.addRow([l.code, l.label, l.note ?? "", num(l.net), num(l.previousNet)]);
      if (l.style === "total" || l.style === "subtotal") row.font = { bold: true };
    }
    ws.columns.forEach((c, i) => (c.width = i === 1 ? 60 : 16));
  };
  statementSheet("Bilan actif", dsf.statements.statements.BILAN_ACTIF, true);
  statementSheet("Bilan passif", dsf.statements.statements.BILAN_PASSIF, false);
  statementSheet("Compte de résultat", dsf.statements.statements.COMPTE_RESULTAT, false);
  statementSheet("TFT", dsf.statements.statements.TFT, false);

  const notes = wb.addWorksheet("Notes");
  header(notes, "Notes annexes");
  for (const n of dsf.statements.notes) {
    notes.addRow([`Note ${n.number}`, n.title, n.status === "COMPUTED" ? "" : "Brouillon à rédiger et valider"]).font = { bold: true };
    for (const r of n.rows) notes.addRow(["", r.label, num(r.amount), num(r.previous)]);
    if (n.rows.length > 0) notes.addRow(["", "Total", num(n.total), num(n.previousTotal)]).font = { italic: true };
    if (n.outline) for (const o of n.outline) notes.addRow(["", `• ${o}`]);
    notes.addRow([]);
  }
  notes.columns.forEach((c, i) => (c.width = i === 1 ? 60 : 18));

  const fiscal = wb.addWorksheet("Passage fiscal");
  header(fiscal, "Détermination du résultat fiscal et de l'impôt");
  const f = dsf.fiscal;
  const rows: Array<[string, Money]> = [
    ["Résultat comptable (XI)", f.accountingResult],
    ["Réintégrations", f.reintegrations],
    ["Déductions", f.deductions],
    ["Résultat fiscal", f.fiscalResult],
    ["Chiffre d'affaires (XB)", f.turnover],
    ["Impôt sur les bénéfices", f.isAmount],
    ["Impôt minimum forfaitaire", f.imfAmount],
    ["Impôt dû", f.isDue],
  ];
  for (const [label, m] of rows) fiscal.addRow([label, num(m)]);
  fiscal.addRow([]);
  fiscal.addRow(["Règles appliquées"]).font = { bold: true };
  for (const r of f.rules) fiscal.addRow([r.id, r.validFrom, r.source ?? ""]);
  fiscal.addRow([]);
  fiscal.addRow(["Contrôles"]).font = { bold: true };
  for (const c of dsf.statements.controls) fiscal.addRow([c.id, c.severity, c.ok ? "OK" : "ÉCHEC", c.detail]);
  fiscal.columns.forEach((c, i) => (c.width = i === 0 ? 40 : 20));

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
