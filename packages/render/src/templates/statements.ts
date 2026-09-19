import { Money } from "@arcompt/ledger";
import type { ComputedLine, ComputedNote, ComputedStatement, Control, StatementCode, StatementsOutput } from "@arcompt/statements";
import { esc, fmt, layout, makeCtx, pageFooter, pageHeader, td, type Ctx } from "../html.js";
import type { LabelKey } from "../i18n.js";
import type { RenderOptions } from "./../views.js";

/**
 * États financiers SYSCOHADA révisé : bilan actif (paysage, 4 colonnes),
 * bilan passif, compte de résultat, TFT, notes annexes et page de contrôles.
 * Les montants suivent la convention du moteur (charges négatives au compte
 * de résultat) et sont formatés par Money.format.
 */
export function renderStatements(out: StatementsOutput, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, out.currency);
  const meta = statementMeta(ctx, out);
  const parts: string[] = [];

  const actif = out.statements.BILAN_ACTIF;
  if (actif) parts.push(page(ctx, "bilanActif", meta, bilanActifTable(ctx, actif), true));
  const passif = out.statements.BILAN_PASSIF;
  if (passif) parts.push(page(ctx, "bilanPassif", meta, twoColumnTable(ctx, passif, "passif", "netPrev", "net")));
  const cr = out.statements.COMPTE_RESULTAT;
  if (cr) parts.push(page(ctx, "compteResultat", meta, twoColumnTable(ctx, cr, "label", "exercicePrev", "exerciceN")));
  const tft = out.statements.TFT;
  if (tft) parts.push(page(ctx, "tft", meta, tftTable(ctx, tft)));
  parts.push(page(ctx, "notes", meta, out.notes.map((n) => noteSection(ctx, n, out)).join("")));
  parts.push(page(ctx, "controls", meta, controlsSection(ctx, out)));

  const title = `${ctx.L("statementsTitle")} ${out.fiscalYearCode}`;
  return layout(ctx, title, parts.join("\n"));
}

function statementMeta(ctx: Ctx, out: StatementsOutput): string[] {
  return [
    `${esc(ctx.L("fiscalYear"))} <b>${esc(out.fiscalYearCode)}</b>`,
    `${esc(ctx.L("system"))} : ${esc(out.system === "SMT" ? ctx.L("systemSmt") : ctx.L("systemNormal"))}`,
    `${esc(ctx.L("amountsIn"))} <b>${esc(out.currency)}</b>`,
    `<span class="muted">SYSCOHADA ${esc(out.templateId)} ${esc(out.templateVersion)}</span>`,
  ];
}

function page(ctx: Ctx, titleKey: LabelKey, meta: string[], body: string, landscape = false): string {
  return `<section class="page${landscape ? " landscape" : ""}">
${pageHeader(ctx, ctx.L("statementsTitle"), meta)}
<h1>${esc(ctx.L(titleKey))}</h1>
${body}
${pageFooter(ctx)}
</section>`;
}

function rowClass(line: ComputedLine): string {
  return line.style === "line" ? "" : ` class="${line.style}"`;
}

function noteRef(line: ComputedLine): string {
  return `<td class="note">${line.note !== undefined ? esc(line.note) : ""}</td>`;
}

function bilanActifTable(ctx: Ctx, st: ComputedStatement): string {
  const c = ctx.currency;
  const rows = st.lines
    .map(
      (l) => `<tr${rowClass(l)}><td class="code">${esc(l.code)}</td><td>${esc(l.label)}</td>${noteRef(l)}${td(l.brut, c)}${td(l.amortProv, c)}${td(l.net, c)}${td(l.previousNet, c)}</tr>`,
    )
    .join("\n");
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L("actif"))}</th><th>${esc(ctx.L("note"))}</th><th colspan="3">${esc(ctx.L("exerciceN"))}</th><th>${esc(ctx.L("exercicePrev"))}</th></tr>
<tr><th></th><th></th><th></th><th>${esc(ctx.L("brut"))}</th><th>${esc(ctx.L("amortProv"))}</th><th>${esc(ctx.L("net"))}</th><th>${esc(ctx.L("netPrev"))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** Passif et compte de résultat : Réf | Libellé | Note | N | N-1. */
function twoColumnTable(ctx: Ctx, st: ComputedStatement, labelKey: LabelKey, prevKey: LabelKey, curKey: LabelKey): string {
  const c = ctx.currency;
  const rows = st.lines.map((l) => `<tr${rowClass(l)}><td class="code">${esc(l.code)}</td><td>${esc(l.label)}</td>${noteRef(l)}${td(l.net, c)}${td(l.previousNet, c)}</tr>`).join("\n");
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L(labelKey))}</th><th>${esc(ctx.L("note"))}</th><th>${esc(ctx.L(curKey))}</th><th>${esc(ctx.L(prevKey))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** TFT : la colonne N-1 exigerait une balance N-2 ; seul l'exercice N est présenté. */
function tftTable(ctx: Ctx, st: ComputedStatement): string {
  const rows = st.lines.map((l) => `<tr${rowClass(l)}><td class="code">${esc(l.code)}</td><td>${esc(l.label)}</td>${td(l.net, ctx.currency)}</tr>`).join("\n");
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("exerciceN"))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

const STATEMENT_KEY: Record<StatementCode, LabelKey> = { BILAN_ACTIF: "bilanActif", BILAN_PASSIF: "bilanPassif", COMPTE_RESULTAT: "compteResultat", TFT: "tft" };

function noteSection(ctx: Ctx, note: ComputedNote, out: StatementsOutput): string {
  const c = ctx.currency;
  const head = `<h2>${esc(ctx.L("note"))} ${esc(note.number)} – ${esc(note.title)}</h2>`;
  if (note.kind !== "LEDGER" || note.status === "DRAFT_REQUIRED") {
    const outline = (note.outline ?? []).map((o) => `<li>${esc(o)}</li>`).join("");
    return `<section class="note">${head}
<div class="banner">${esc(ctx.L("draftToValidate"))}</div>
<p class="small">${esc(note.kind === "MODULE" ? ctx.L("moduleNoteHint") : ctx.L("draftNoteHint"))}</p>
${outline ? `<ol class="outline">${outline}</ol>` : ""}
</section>`;
  }
  const rows = note.rows.map((r) => `<tr><td>${esc(r.label)}</td>${td(r.amount, c)}${td(r.previous, c)}</tr>`).join("\n");
  let recon = "";
  if (note.reconciles) {
    const stLabel = ctx.L(STATEMENT_KEY[note.reconciles.statement]);
    const lineLabel = out.statements[note.reconciles.statement]?.byCode[note.reconciles.code]?.label ?? "";
    const status = note.reconciles.ok
      ? `<span class="badge ok">${esc(ctx.L("reconciledOk"))}</span>`
      : `<span class="badge ko">${esc(ctx.L("reconciledKo"))}</span> — ${esc(ctx.L("expected"))} ${esc(fmt(note.reconciles.expected, c, { zero: "zero" }))}, ${esc(ctx.L("actual"))} ${esc(fmt(note.total, c, { zero: "zero" }))}`;
    recon = `<p class="small">${esc(ctx.L("reconciledWith"))} <b>${esc(note.reconciles.code)}</b> (${esc(stLabel)}${lineLabel ? ` – ${esc(lineLabel)}` : ""}) : ${status}</p>`;
  }
  return `<section class="note">${head}
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("exerciceN"))}</th><th>${esc(ctx.L("exercicePrev"))}</th></tr></thead>
<tbody>${rows}
<tr class="total"><td>${esc(ctx.L("total"))}</td>${td(note.total, c)}${td(note.previousTotal, c)}</tr></tbody>
</table>
${recon}
</section>`;
}

function controlRow(ctx: Ctx, ctl: Control): string {
  const sev = ctl.severity === "BLOCKING" ? `<span class="badge blocking">${esc(ctx.L("blocking"))}</span>` : `<span class="badge warning">${esc(ctx.L("warning"))}</span>`;
  const res = ctl.ok ? `<span class="badge ok">${esc(ctx.L("ok"))}</span>` : `<span class="badge ko">${esc(ctx.L("ko"))}</span>`;
  const values = [ctl.expected !== undefined ? `${esc(ctx.L("expected"))} : ${esc(ctl.expected)}` : "", ctl.actual !== undefined ? `${esc(ctx.L("actual"))} : ${esc(ctl.actual)}` : ""].filter(Boolean).join(" · ");
  return `<tr><td class="code">${esc(ctl.id)}</td><td>${esc(ctl.label)}</td><td class="center">${sev}</td><td class="center">${res}</td><td>${esc(ctl.detail)}${values ? `<br><span class="small">${values}</span>` : ""}</td></tr>`;
}

function controlsSection(ctx: Ctx, out: StatementsOutput): string {
  const summary = out.publishable
    ? `<p><span class="badge ok">${esc(ctx.L("ok"))}</span> ${esc(ctx.L("publishable"))}</p>`
    : `<p><span class="badge ko">${esc(ctx.L("ko"))}</span> ${esc(ctx.L("notPublishable"))}</p>`;
  const orphans = out.orphanAccounts.length ? `<p class="small"><b>${esc(ctx.L("orphanAccounts"))}</b> : ${out.orphanAccounts.map(esc).join(", ")}</p>` : "";
  return `${summary}
<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L("control"))}</th><th>${esc(ctx.L("severity"))}</th><th>${esc(ctx.L("result"))}</th><th>${esc(ctx.L("detail"))}</th></tr></thead>
<tbody>${out.controls.map((c) => controlRow(ctx, c)).join("\n")}</tbody>
</table>
${orphans}`;
}

/** Résultat net tel qu'affiché (utile aux tests et à l'export Excel). */
export function netResult(out: StatementsOutput): Money {
  return out.statements.COMPTE_RESULTAT?.byCode["XI"]?.net ?? Money.zero();
}
