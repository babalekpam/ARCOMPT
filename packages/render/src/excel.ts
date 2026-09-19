import ExcelJS from "exceljs";
import { CURRENCY_DECIMALS, Money } from "@arcompt/ledger";
import type { ComputedStatement, StatementsOutput } from "@arcompt/statements";
import { t } from "./i18n.js";
import type { Amount, LedgerView, Locale, RenderOptions, TrialBalanceView } from "./views.js";

/**
 * Exports Excel (ExcelJS). Les montants sont écrits comme nombres à partir de
 * la chaîne canonique Money (4 décimales exactes, représentables en double
 * jusqu'à ~10^11 sans perte) avec un format de nombre propre à la devise.
 * C'est le seul endroit où un montant devient un nombre, pour le tableur ;
 * aucun calcul n'est fait sur ces nombres.
 */

export type Workbook = ExcelJS.Workbook;

export function numberFormat(currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const dec = decimals > 0 ? "." + "0".repeat(decimals) : "";
  return `#,##0${dec};[Red]-#,##0${dec}`;
}

/** Cellule numérique depuis un Money (ou sa chaîne). */
export function moneyCell(a: Amount | undefined): number | null {
  if (a === undefined) return null;
  return Number(Money.parse(a).toString());
}

interface SheetCtx {
  wb: ExcelJS.Workbook;
  locale: Locale;
  currency: string;
  numFmt: string;
  company: string;
}

function sheetCtx(wb: ExcelJS.Workbook, currency: string, opts: RenderOptions): SheetCtx {
  return { wb, locale: opts.locale ?? "fr", currency, numFmt: numberFormat(currency), company: opts.company?.name ?? "" };
}

/** Ligne de titre + en-tête d'entreprise + ligne d'exercice en tête de feuille. */
function heading(ws: ExcelJS.Worksheet, ctx: SheetCtx, title: string, subtitle: string): void {
  ws.addRow([title]).font = { bold: true, size: 14 };
  if (ctx.company) ws.addRow([ctx.company]).font = { bold: true };
  ws.addRow([subtitle]);
  ws.addRow([]);
}

function headerRow(ws: ExcelJS.Worksheet, labels: string[]): void {
  const row = ws.addRow(labels);
  row.font = { bold: true };
  row.alignment = { horizontal: "center" };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF5" } };
    cell.border = { bottom: { style: "thin" } };
  });
}

function applyNumFmt(row: ExcelJS.Row, columns: number[], numFmt: string): void {
  for (const c of columns) row.getCell(c).numFmt = numFmt;
}

function styleLine(row: ExcelJS.Row, style: string): void {
  if (style === "total") {
    row.font = { bold: true };
    row.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE6F0" } }));
  } else if (style === "subtotal") {
    row.font = { bold: true };
  } else if (style === "header") {
    row.font = { bold: true };
  }
}

function statementSheet(ctx: SheetCtx, name: string, st: ComputedStatement, out: StatementsOutput, kind: "actif" | "two" | "tft"): void {
  const ws = ctx.wb.addWorksheet(name);
  const L = (k: Parameters<typeof t>[1]) => t(ctx.locale, k);
  heading(ws, ctx, name, `${L("fiscalYear")} ${out.fiscalYearCode} · ${L("amountsIn")} ${out.currency} · ${out.system === "SMT" ? L("systemSmt") : L("systemNormal")}`);
  if (kind === "actif") {
    headerRow(ws, [L("ref"), L("actif"), L("note"), L("brut"), L("amortProv"), L("net"), L("netPrev")]);
    ws.columns = [{ width: 6 }, { width: 60 }, { width: 6 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
    for (const l of st.lines) {
      const row = ws.addRow([l.code, l.label, l.note ?? null, moneyCell(l.brut), moneyCell(l.amortProv), moneyCell(l.net), moneyCell(l.previousNet)]);
      applyNumFmt(row, [4, 5, 6, 7], ctx.numFmt);
      styleLine(row, l.style);
    }
  } else if (kind === "two") {
    headerRow(ws, [L("ref"), L("label"), L("note"), L("exerciceN"), L("exercicePrev")]);
    ws.columns = [{ width: 6 }, { width: 60 }, { width: 6 }, { width: 18 }, { width: 18 }];
    for (const l of st.lines) {
      const row = ws.addRow([l.code, l.label, l.note ?? null, moneyCell(l.net), moneyCell(l.previousNet)]);
      applyNumFmt(row, [4, 5], ctx.numFmt);
      styleLine(row, l.style);
    }
  } else {
    headerRow(ws, [L("ref"), L("label"), L("exerciceN")]);
    ws.columns = [{ width: 6 }, { width: 70 }, { width: 18 }];
    for (const l of st.lines) {
      const row = ws.addRow([l.code, l.label, moneyCell(l.net)]);
      applyNumFmt(row, [3], ctx.numFmt);
      styleLine(row, l.style);
    }
  }
}

/** Classeur des états financiers : Bilan actif, Bilan passif, Compte de résultat, TFT, Notes, Contrôles. */
export async function statementsWorkbook(out: StatementsOutput, opts: RenderOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ARCOMPT";
  const ctx = sheetCtx(wb, out.currency, opts);
  const L = (k: Parameters<typeof t>[1]) => t(ctx.locale, k);

  if (out.statements.BILAN_ACTIF) statementSheet(ctx, "Bilan actif", out.statements.BILAN_ACTIF, out, "actif");
  if (out.statements.BILAN_PASSIF) statementSheet(ctx, "Bilan passif", out.statements.BILAN_PASSIF, out, "two");
  if (out.statements.COMPTE_RESULTAT) statementSheet(ctx, "Compte de résultat", out.statements.COMPTE_RESULTAT, out, "two");
  if (out.statements.TFT) statementSheet(ctx, "TFT", out.statements.TFT, out, "tft");

  const notes = wb.addWorksheet("Notes");
  heading(notes, ctx, L("notes"), `${L("fiscalYear")} ${out.fiscalYearCode} · ${L("amountsIn")} ${out.currency}`);
  notes.columns = [{ width: 8 }, { width: 60 }, { width: 18 }, { width: 18 }, { width: 30 }];
  for (const n of out.notes) {
    notes.addRow([`${L("note")} ${n.number}`, n.title]).font = { bold: true, size: 12 };
    if (n.kind !== "LEDGER" || n.status === "DRAFT_REQUIRED") {
      const banner = notes.addRow([null, L("draftToValidate")]);
      banner.font = { bold: true, color: { argb: "FFB00020" } };
      for (const o of n.outline ?? []) notes.addRow([null, `– ${o}`]);
    } else {
      headerRow(notes, ["", L("label"), L("exerciceN"), L("exercicePrev")]);
      for (const r of n.rows) applyNumFmt(notes.addRow([null, r.label, moneyCell(r.amount), moneyCell(r.previous)]), [3, 4], ctx.numFmt);
      const total = notes.addRow([null, L("total"), moneyCell(n.total), moneyCell(n.previousTotal)]);
      applyNumFmt(total, [3, 4], ctx.numFmt);
      total.font = { bold: true };
      if (n.reconciles) {
        const row = notes.addRow([null, `${L("reconciledWith")} ${n.reconciles.code}`, moneyCell(n.reconciles.expected), null, n.reconciles.ok ? L("reconciledOk") : L("reconciledKo")]);
        applyNumFmt(row, [3], ctx.numFmt);
        row.getCell(5).font = { bold: true, color: { argb: n.reconciles.ok ? "FF157347" : "FFB00020" } };
      }
    }
    notes.addRow([]);
  }

  const controls = wb.addWorksheet("Contrôles");
  heading(controls, ctx, L("controls"), out.publishable ? L("publishable") : L("notPublishable"));
  controls.columns = [{ width: 28 }, { width: 50 }, { width: 12 }, { width: 10 }, { width: 60 }, { width: 20 }, { width: 20 }];
  headerRow(controls, [L("ref"), L("control"), L("severity"), L("result"), L("detail"), L("expected"), L("actual")]);
  for (const c of out.controls) {
    const row = controls.addRow([c.id, c.label, c.severity === "BLOCKING" ? L("blocking") : L("warning"), c.ok ? L("ok") : L("ko"), c.detail, c.expected ?? null, c.actual ?? null]);
    row.getCell(4).font = { bold: true, color: { argb: c.ok ? "FF157347" : "FFB00020" } };
  }
  if (out.orphanAccounts.length) {
    controls.addRow([]);
    controls.addRow([L("orphanAccounts"), out.orphanAccounts.join(", ")]);
  }

  return toBuffer(wb);
}

/** Classeur de la balance générale. */
export async function trialBalanceWorkbook(view: TrialBalanceView, opts: RenderOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ARCOMPT";
  const ctx = sheetCtx(wb, view.currency, opts);
  const L = (k: Parameters<typeof t>[1]) => t(ctx.locale, k);
  const ws = wb.addWorksheet("Balance");
  heading(ws, ctx, L("trialBalance"), `${L("fiscalYear")} ${view.fiscalYearCode} · ${view.from} → ${view.to} · ${L("amountsIn")} ${view.currency}`);
  ws.columns = [{ width: 10 }, { width: 50 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  headerRow(ws, [L("account"), L("accountLabel"), L("debit"), L("credit"), L("debitBalance"), L("creditBalance")]);
  let sd = Money.zero();
  let sc = Money.zero();
  for (const r of [...view.rows].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber))) {
    const balance = Money.parse(r.debit).sub(Money.parse(r.credit));
    const d = balance.isPositive() ? balance : Money.zero();
    const c = balance.isNegative() ? balance.neg() : Money.zero();
    sd = sd.add(d);
    sc = sc.add(c);
    applyNumFmt(ws.addRow([r.accountNumber, r.label, moneyCell(r.debit), moneyCell(r.credit), moneyCell(d), moneyCell(c)]), [3, 4, 5, 6], ctx.numFmt);
  }
  const total = ws.addRow([null, L("generalTotal"), moneyCell(view.totalDebit), moneyCell(view.totalCredit), moneyCell(sd), moneyCell(sc)]);
  applyNumFmt(total, [3, 4, 5, 6], ctx.numFmt);
  styleLine(total, "total");
  return toBuffer(wb);
}

/** Classeur du grand livre : une feuille « Grand livre » avec toutes les lignes, plus une feuille « Soldes ». */
export async function ledgerWorkbook(view: LedgerView, opts: RenderOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ARCOMPT";
  const ctx = sheetCtx(wb, view.currency, opts);
  const L = (k: Parameters<typeof t>[1]) => t(ctx.locale, k);
  const ws = wb.addWorksheet("Grand livre");
  heading(ws, ctx, L("ledger"), `${L("fiscalYear")} ${view.fiscalYearCode} · ${view.from} → ${view.to} · ${L("amountsIn")} ${view.currency}`);
  ws.columns = [{ width: 10 }, { width: 30 }, { width: 12 }, { width: 8 }, { width: 8 }, { width: 14 }, { width: 40 }, { width: 18 }, { width: 18 }, { width: 18 }];
  headerRow(ws, [L("account"), L("accountLabel"), L("date"), L("journal"), L("entryNumber"), L("reference"), L("label"), L("debit"), L("credit"), L("balance")]);
  for (const a of view.accounts) {
    let running = Money.zero();
    for (const l of a.lines) {
      running = running.add(Money.parse(l.debit)).sub(Money.parse(l.credit));
      applyNumFmt(ws.addRow([a.accountNumber, a.label, l.date, l.journalCode, l.entryNumber, l.reference, l.label, moneyCell(l.debit), moneyCell(l.credit), moneyCell(running)]), [8, 9, 10], ctx.numFmt);
    }
    const total = ws.addRow([a.accountNumber, a.label, null, null, null, null, L("accountTotal"), moneyCell(a.totalDebit), moneyCell(a.totalCredit), moneyCell(a.balance)]);
    applyNumFmt(total, [8, 9, 10], ctx.numFmt);
    styleLine(total, "total");
  }
  const sums = wb.addWorksheet("Soldes");
  heading(sums, ctx, L("balance"), `${L("fiscalYear")} ${view.fiscalYearCode}`);
  sums.columns = [{ width: 10 }, { width: 40 }, { width: 18 }, { width: 18 }, { width: 18 }];
  headerRow(sums, [L("account"), L("accountLabel"), L("debit"), L("credit"), L("balance")]);
  for (const a of view.accounts) applyNumFmt(sums.addRow([a.accountNumber, a.label, moneyCell(a.totalDebit), moneyCell(a.totalCredit), moneyCell(a.balance)]), [3, 4, 5], ctx.numFmt);
  return toBuffer(wb);
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}
