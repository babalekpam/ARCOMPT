import { Money } from "@arcompt/ledger";
import type { ComputedLine, ComputedNote, ComputedStatement, Control, StatementCode, StatementsOutput } from "@arcompt/statements";
import { esc, layout, makeCtx, pageFooter, pageHeader, td, type Ctx } from "../html.js";
import type { LabelKey } from "../i18n.js";
import { noteOutlineEn, noteRowEn, noteTitleGloss, statementLineGloss } from "../syscohada-en.js";
import type { RenderOptions } from "./../views.js";

/**
 * États financiers SYSCOHADA révisé : bilan actif (paysage, 4 colonnes),
 * bilan passif, compte de résultat, TFT, notes annexes et page de contrôles.
 * Les montants suivent la convention du moteur (charges négatives au compte
 * de résultat) et sont formatés selon la devise et la langue.
 *
 * ── Langue ───────────────────────────────────────────────────────────────
 *
 * Les intitulés de postes sont du texte réglementaire : ils restent en
 * français dans les deux langues, et l'anglais s'ajoute en glose à côté (voir
 * `syscohada-en.ts`). Seuls les titres, en-têtes de colonnes, contrôles et
 * mentions génériques sont traduits.
 */
export function renderStatements(out: StatementsOutput, opts: RenderOptions = {}): string {
  const ctx = makeCtx(opts, out.currency);
  const meta = statementMeta(ctx, out);
  const parts: string[] = [];

  const actif = out.statements.BILAN_ACTIF;
  if (actif) parts.push(page(ctx, "bilanActif", actif.title, meta, bilanActifTable(ctx, actif), true));
  const passif = out.statements.BILAN_PASSIF;
  if (passif) parts.push(page(ctx, "bilanPassif", passif.title, meta, twoColumnTable(ctx, passif, "passif", "netPrev", "net")));
  const cr = out.statements.COMPTE_RESULTAT;
  if (cr) parts.push(page(ctx, "compteResultat", cr.title, meta, twoColumnTable(ctx, cr, "label", "exercicePrev", "exerciceN")));
  const tft = out.statements.TFT;
  if (tft) parts.push(page(ctx, "tft", tft.title, meta, tftTable(ctx, tft)));
  parts.push(page(ctx, "notes", undefined, meta, out.notes.map((n) => noteSection(ctx, n, out)).join("")));
  parts.push(page(ctx, "controls", undefined, meta, controlsSection(ctx, out)));

  const title = `${ctx.L("statementsTitle")} ${out.fiscalYearCode}`;
  return layout(ctx, title, parts.join("\n"));
}

function statementMeta(ctx: Ctx, out: StatementsOutput): string[] {
  return [
    `${esc(ctx.L("fiscalYear"))} <b>${esc(out.fiscalYearCode)}</b>`,
    ctx.kv(esc(ctx.L("system")), esc(out.system === "SMT" ? ctx.L("systemSmt") : ctx.L("systemNormal"))),
    `${esc(ctx.L("amountsIn"))} <b>${esc(out.currency)}</b>`,
    `<span class="muted">SYSCOHADA ${esc(out.templateId)} ${esc(out.templateVersion)}</span>`,
  ];
}

/**
 * Une page d'état. En anglais, le titre officiel français du formulaire est
 * rappelé sous le titre traduit : c'est lui qui identifie le document devant
 * l'administration, et il ne doit pas disparaître parce que la langue change.
 */
function page(ctx: Ctx, titleKey: LabelKey, officialTitle: string | undefined, meta: string[], body: string, landscape = false): string {
  const official = ctx.locale === "en" && officialTitle && officialTitle !== ctx.L(titleKey) ? `<p class="small muted official">${esc(ctx.kv(ctx.L("officialCaption"), officialTitle))}</p>` : "";
  return `<section class="page${landscape ? " landscape" : ""}">
${pageHeader(ctx, ctx.L("statementsTitle"), meta)}
<h1>${esc(ctx.L(titleKey))}</h1>
${official}
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

/**
 * Cellule d'intitulé. Le libellé officiel français est toujours écrit en
 * premier et jamais modifié ; en anglais, la glose le suit, en italique gris,
 * pour qu'on voie d'un coup d'œil ce qui est le formulaire et ce qui est
 * l'aide à la lecture.
 */
function labelCell(ctx: Ctx, line: ComputedLine, indent = false): string {
  const gloss = ctx.locale === "en" ? statementLineGloss(line.code) : undefined;
  const inner = gloss ? `${esc(line.label)} <span class="gloss">${esc(gloss)}</span>` : esc(line.label);
  return `<td${indent ? ' class="lbl"' : ""}>${inner}</td>`;
}

function bilanActifTable(ctx: Ctx, st: ComputedStatement): string {
  const rows = st.lines
    .map((l) => `<tr${rowClass(l)}><td class="code">${esc(l.code)}</td>${labelCell(ctx, l)}${noteRef(l)}${td(ctx, l.brut)}${td(ctx, l.amortProv)}${td(ctx, l.net)}${td(ctx, l.previousNet)}</tr>`)
    .join("\n");
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L("actif"))}</th><th>${esc(ctx.L("note"))}</th><th colspan="3">${esc(ctx.L("exerciceN"))}</th><th>${esc(ctx.L("exercicePrev"))}</th></tr>
<tr><th></th><th></th><th></th><th>${esc(ctx.L("brut"))}</th><th>${esc(ctx.L("amortProv"))}</th><th>${esc(ctx.L("net"))}</th><th>${esc(ctx.L("netPrev"))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** Passif et compte de résultat : Réf | Libellé | Note | N | N-1. */
function twoColumnTable(ctx: Ctx, st: ComputedStatement, labelKey: LabelKey, prevKey: LabelKey, curKey: LabelKey): string {
  const rows = st.lines.map((l) => `<tr${rowClass(l)}><td class="code">${esc(l.code)}</td>${labelCell(ctx, l)}${noteRef(l)}${td(ctx, l.net)}${td(ctx, l.previousNet)}</tr>`).join("\n");
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L(labelKey))}</th><th>${esc(ctx.L("note"))}</th><th>${esc(ctx.L(curKey))}</th><th>${esc(ctx.L(prevKey))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** TFT : la colonne N-1 exigerait une balance N-2 ; seul l'exercice N est présenté. */
function tftTable(ctx: Ctx, st: ComputedStatement): string {
  const rows = st.lines.map((l) => `<tr${rowClass(l)}><td class="code">${esc(l.code)}</td>${labelCell(ctx, l)}${td(ctx, l.net)}</tr>`).join("\n");
  return `<table class="fin">
<thead><tr><th>${esc(ctx.L("ref"))}</th><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("exerciceN"))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

const STATEMENT_KEY: Record<StatementCode, LabelKey> = { BILAN_ACTIF: "bilanActif", BILAN_PASSIF: "bilanPassif", COMPTE_RESULTAT: "compteResultat", TFT: "tft" };

function noteSection(ctx: Ctx, note: ComputedNote, out: StatementsOutput): string {
  const gloss = ctx.locale === "en" ? noteTitleGloss(note.number) : undefined;
  const title = gloss ? `${esc(note.title)} <span class="gloss">${esc(gloss)}</span>` : esc(note.title);
  const head = `<h2>${esc(ctx.L("note"))} ${esc(note.number)} – ${title}</h2>`;
  if (note.kind !== "LEDGER" || note.status === "DRAFT_REQUIRED") {
    // La trame de rédaction est une consigne, pas du texte réglementaire : en
    // anglais elle est TRADUITE, non glosée. Une note à rédiger dont le mode
    // d'emploi reste en français n'aide personne.
    const bullets = (ctx.locale === "en" ? noteOutlineEn(note.number) : undefined) ?? note.outline ?? [];
    const outline = bullets.map((o) => `<li>${esc(o)}</li>`).join("");
    return `<section class="note">${head}
<div class="banner">${esc(ctx.L("draftToValidate"))}</div>
<p class="small">${esc(note.kind === "MODULE" ? ctx.L("moduleNoteHint") : ctx.L("draftNoteHint"))}</p>
${outline ? `<ol class="outline">${outline}</ol>` : ""}
</section>`;
  }
  // Les lignes de notes ne sont pas du texte réglementaire : elles sont
  // TRADUITES, pas glosées. Une traduction manquante laisse le français plutôt
  // que de rendre une ligne vide ; le garde-fou de complétude la signale.
  const rows = note.rows
    .map((r) => `<tr><td>${esc((ctx.locale === "en" ? noteRowEn(r.label) : undefined) ?? r.label)}</td>${td(ctx, r.amount)}${td(ctx, r.previous)}</tr>`)
    .join("\n");
  let recon = "";
  if (note.reconciles) {
    const stLabel = ctx.L(STATEMENT_KEY[note.reconciles.statement]);
    const lineLabel = out.statements[note.reconciles.statement]?.byCode[note.reconciles.code]?.label ?? "";
    const status = note.reconciles.ok
      ? `<span class="badge ok">${esc(ctx.L("reconciledOk"))}</span>`
      : `<span class="badge ko">${esc(ctx.L("reconciledKo"))}</span> — ${esc(ctx.L("expected"))} ${esc(ctx.n(note.reconciles.expected, { zero: "zero" }))}, ${esc(ctx.L("actual"))} ${esc(ctx.n(note.total, { zero: "zero" }))}`;
    recon = `<p class="small">${ctx.kv(`${esc(ctx.L("reconciledWith"))} <b>${esc(note.reconciles.code)}</b> (${esc(stLabel)}${lineLabel ? ` – ${esc(lineLabel)}` : ""})`, status)}</p>`;
  }
  return `<section class="note">${head}
<table class="fin">
<thead><tr><th>${esc(ctx.L("label"))}</th><th>${esc(ctx.L("exerciceN"))}</th><th>${esc(ctx.L("exercicePrev"))}</th></tr></thead>
<tbody>${rows}
<tr class="total"><td>${esc(ctx.L("total"))}</td>${td(ctx, note.total)}${td(ctx, note.previousTotal)}</tr></tbody>
</table>
${recon}
</section>`;
}

function controlRow(ctx: Ctx, ctl: Control): string {
  const sev = ctl.severity === "BLOCKING" ? `<span class="badge blocking">${esc(ctx.L("blocking"))}</span>` : `<span class="badge warning">${esc(ctx.L("warning"))}</span>`;
  const res = ctl.ok ? `<span class="badge ok">${esc(ctx.L("ok"))}</span>` : `<span class="badge ko">${esc(ctx.L("ko"))}</span>`;
  const values = [ctl.expected !== undefined ? esc(ctx.kv(ctx.L("expected"), String(ctl.expected))) : "", ctl.actual !== undefined ? esc(ctx.kv(ctx.L("actual"), String(ctl.actual))) : ""].filter(Boolean).join(" · ");
  // Un contrôle n'est pas du texte réglementaire : c'est un diagnostic adressé
  // à qui produit la liasse. Il est donc traduit, pas glosé — et les phrases
  // anglaises sont rédigées avec le contrôle (packages/statements/src/controls.ts),
  // parce qu'elles portent des montants et des numéros de compte interpolés.
  const label = (ctx.locale === "en" ? ctl.labelEn : undefined) ?? ctl.label;
  const detail = (ctx.locale === "en" ? ctl.detailEn : undefined) ?? ctl.detail;
  return `<tr><td class="code">${esc(ctl.id)}</td><td>${esc(label)}</td><td class="center">${sev}</td><td class="center">${res}</td><td>${esc(detail)}${values ? `<br><span class="small">${values}</span>` : ""}</td></tr>`;
}

function controlsSection(ctx: Ctx, out: StatementsOutput): string {
  const summary = out.publishable
    ? `<p><span class="badge ok">${esc(ctx.L("ok"))}</span> ${esc(ctx.L("publishable"))}</p>`
    : `<p><span class="badge ko">${esc(ctx.L("ko"))}</span> ${esc(ctx.L("notPublishable"))}</p>`;
  const orphans = out.orphanAccounts.length ? `<p class="small">${ctx.kv(`<b>${esc(ctx.L("orphanAccounts"))}</b>`, out.orphanAccounts.map(esc).join(", "))}</p>` : "";
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
